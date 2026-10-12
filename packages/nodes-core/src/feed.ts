import { XMLParser } from 'fast-xml-parser';
import { NodeError } from '@pulseflow/engine';

export interface FeedEntry {
  id: string;
  title: string;
  link: string;
  published: string | null;
  summary: string;
}

const text = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v).trim();
  if (typeof v === 'object' && '#text' in (v as object)) return String((v as Record<string, unknown>)['#text']).trim();
  return '';
};

const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

const isoOrNull = (v: string): string | null => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** Parses RSS 2.0 or Atom feeds. Entity expansion is disabled (no XXE / billion-laughs). */
export function parseFeed(xml: string): FeedEntry[] {
  if (xml.length > 10 * 1024 * 1024) throw new NodeError('FEED_TOO_LARGE', 'Feed exceeds 10 MB');
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', processEntities: false, htmlEntities: false });
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch (e) {
    throw new NodeError('FEED_PARSE_ERROR', `Invalid feed XML: ${(e as Error).message}`);
  }
  const rss = doc.rss as { channel?: { item?: unknown } } | undefined;
  if (rss?.channel) {
    return arr(rss.channel.item as Record<string, unknown>[] | Record<string, unknown>).map((it) => {
      const link = decode(text(it.link));
      const guid = decode(text(it.guid));
      return {
        id: guid || link || decode(text(it.title)),
        title: decode(text(it.title)),
        link,
        published: isoOrNull(text(it.pubDate)),
        summary: decode(text(it.description)).slice(0, 2000),
      };
    });
  }
  const feed = doc.feed as { entry?: unknown } | undefined;
  if (feed) {
    return arr(feed.entry as Record<string, unknown>[] | Record<string, unknown>).map((it) => {
      const links = arr(it.link as Record<string, unknown>[] | Record<string, unknown>);
      const alt = links.find((l) => !l['@rel'] || l['@rel'] === 'alternate') ?? links[0];
      const link = alt ? decode(String(alt['@href'] ?? '')) : '';
      return {
        id: decode(text(it.id)) || link,
        title: decode(text(it.title)),
        link,
        published: isoOrNull(text(it.published) || text(it.updated)),
        summary: decode(text(it.summary) || text(it.content)).slice(0, 2000),
      };
    });
  }
  throw new NodeError('FEED_PARSE_ERROR', 'Document is not an RSS or Atom feed');
}

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]{1,6});/gi, (m, h: string) => codePoint(parseInt(h, 16), m))
    .replace(/&#([0-9]{1,7});/g, (m, d: string) => codePoint(parseInt(d, 10), m))
    .replace(/&amp;/g, '&');
}

function codePoint(n: number, fallback: string): string {
  return n > 0 && n <= 0x10ffff && (n < 0xd800 || n > 0xdfff) ? String.fromCodePoint(n) : fallback;
}

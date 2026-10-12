import { describe, expect, it } from 'vitest';
import { csvToObjects, objectsToCsv, parseCsv, parseFeed, validateJsonSchema } from '../src';

describe('CSV', () => {
  it('parses quotes, doubled quotes, embedded newlines, CRLF and BOM', () => {
    const rows = parseCsv('\uFEFFa,b\r\n"x, y","he said ""hi"""\r\n"multi\nline",z\r\n');
    expect(rows).toEqual([
      ['a', 'b'],
      ['x, y', 'he said "hi"'],
      ['multi\nline', 'z'],
    ]);
    expect(csvToObjects('name,age\nAda,36\n')).toEqual([{ name: 'Ada', age: '36' }]);
  });

  it('escapes output and neutralizes spreadsheet formulas', () => {
    const csv = objectsToCsv([{ a: 'plain', b: 'has,comma', c: 'quote"d', d: '=SUM(A1)', e: 'line\nbreak' }], { escapeFormulas: true });
    const [header, row] = [csv.split(/\r?\n/)[0], csv.slice(csv.indexOf('\n') + 1)];
    expect(header).toBe('a,b,c,d,e');
    expect(row).toContain('"has,comma"');
    expect(row).toContain('"quote""d"');
    expect(row).toContain("'=SUM(A1)");
    expect(row).toContain('"line\nbreak"');
  });
});

describe('feeds', () => {
  it('parses RSS and Atom entries with stable ids', () => {
    const rss = parseFeed('<rss><channel><item><guid>1</guid><title>One &amp; two</title><link>https://e.x/1</link><pubDate>Mon, 05 Jan 2026 10:00:00 GMT</pubDate></item></channel></rss>');
    expect(rss[0]).toMatchObject({ id: '1', title: 'One & two', link: 'https://e.x/1' });
    const atom = parseFeed('<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>urn:a</id><title>A</title><link href="https://e.x/a"/><updated>2026-01-05T10:00:00Z</updated></entry></feed>');
    expect(atom[0]).toMatchObject({ id: 'urn:a', title: 'A', link: 'https://e.x/a' });
  });

  it('does not expand XML entities (billion laughs)', () => {
    const evil = '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;">]><rss><channel><item><title>&lol2;</title><guid>x</guid></item></channel></rss>';
    const out = parseFeed(evil);
    expect(JSON.stringify(out)).not.toContain('lollollol');
  });
});

describe('JSON schema subset', () => {
  const schema = { type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' }, age: { type: 'integer', minimum: 0 } }, additionalProperties: false } as const;
  it('accepts valid data and reports precise errors', () => {
    expect(validateJsonSchema({ email: 'a@b.co', age: 3 }, schema)).toEqual([]);
    const errors = validateJsonSchema({ email: 'nope', age: -1, extra: 1 }, schema);
    expect(errors.map((e) => e.path).sort()).toEqual(['$.age', '$.email', '$.extra']);
    expect(validateJsonSchema({}, schema)[0]).toMatchObject({ path: '$.email', message: 'is required' });
  });
});

import { NextRequest, NextResponse } from 'next/server';
import { getStorage } from '@/lib/storage';

/** GET /sitemap.xml — all public pages: home, submit, and every venue page. */
export async function GET(req: NextRequest) {
  const proto = req.headers.get('x-forwarded-proto') ?? 'https';
  const host = req.headers.get('host') ?? '';
  const origin = `${proto}://${host}`;

  const store = getStorage();
  const venues = await store.listVenues();

  const urls = [
    { loc: origin + '/', priority: '1.0' },
    { loc: origin + '/submit', priority: '0.8' },
    ...venues.map((v) => ({ loc: origin + '/venue/' + v.id, priority: '0.7' })),
  ];

  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls
      .map(
        (u) =>
          `  <url>\n    <loc>${u.loc}</loc>\n    <priority>${u.priority}</priority>\n  </url>`,
      )
      .join('\n') +
    '\n</urlset>\n';

  return new NextResponse(xml, {
    headers: { 'content-type': 'application/xml; charset=utf-8' },
  });
}

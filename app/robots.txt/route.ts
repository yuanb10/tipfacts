import { NextResponse } from 'next/server';

/** GET /robots.txt — allow everything; sitemap served at /sitemap.xml. */
export async function GET() {
  const body = 'User-agent: *\nAllow: /\nSitemap: /sitemap.xml\n';
  return new NextResponse(body, {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

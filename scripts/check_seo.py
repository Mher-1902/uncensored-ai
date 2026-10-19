"""Check the published HTML and crawler files together, without dependencies."""
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
NS = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}


def require(condition, message):
    if not condition:
        raise SystemExit(f"SEO check failed: {message}")


class Page(HTMLParser):
    def __init__(self, path):
        super().__init__(convert_charrefs=True)
        self.meta, self.canonicals, self.titles, self.h1, self.preloads = {}, [], [], [], []
        self.language = None
        self.capture = None
        self.feed(path.read_text(encoding="utf-8"))

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag == "html":
            self.language = values.get("lang")
        elif tag == "meta":
            key = values.get("name") or values.get("property")
            if key:
                require(key not in self.meta, f"duplicate {key} metadata")
                self.meta[key] = values.get("content", "")
        elif tag == "link" and "canonical" in values.get("rel", "").split():
            self.canonicals.append(values.get("href"))
        elif tag == "link" and "preload" in values.get("rel", "").split():
            self.preloads.append(values.get("href", ""))
        if tag in ("title", "h1"):
            self.capture = tag
            (self.titles if tag == "title" else self.h1).append("")

    def handle_data(self, data):
        if self.capture:
            (self.titles if self.capture == "title" else self.h1)[-1] += data

    def handle_endtag(self, tag):
        if tag == self.capture:
            self.capture = None


home = Page(DIST / "index.html")
missing = Page(DIST / "404.html")
for label, page in (("homepage", home), ("404", missing)):
    require(page.language == "en", f"{label} needs its language declared")
    require(len(page.titles) == 1 and page.titles[0].strip(), f"{label} needs one title")
    require(page.meta.get("description", "").strip(), f"{label} needs a description")
    require(len(page.h1) == 1 and page.h1[0].strip(), f"{label} needs one rendered H1")
    for asset in page.preloads:
        require(asset.startswith("/") and (DIST / asset.lstrip("/")).is_file(), f"{label} preloads an unavailable asset")
require(home.titles != missing.titles, "pages need distinct titles")
require(home.meta["description"] != missing.meta["description"], "pages need distinct descriptions")
require("noindex" not in home.meta.get("robots", ""), "homepage must be indexable")
require("noindex" in missing.meta.get("robots", ""), "404 must not be indexed")
require(not missing.canonicals, "404 must not impersonate a valid canonical page")
require("offscript" in home.h1[0].lower(), "brand must appear in initial HTML before JavaScript")
require(len(home.canonicals) == 1, "homepage needs one canonical URL")
canonical = home.canonicals[0]
address = urlsplit(canonical)
require(address.scheme == "https" and address.netloc and address.path == "/"
        and not address.query and not address.fragment, "canonical must be an absolute HTTPS homepage")
require("__SITE_ORIGIN__" not in (DIST / "index.html").read_text(), "unresolved canonical placeholder")
require(home.meta.get("og:url") == canonical, "social and canonical URLs must agree")
privacy = Page(DIST / "privacy.html")
require(privacy.language == "en" and len(privacy.h1) == 1 and privacy.h1[0] == "Privacy Policy", "privacy notice needs a complete initial HTML document")
require(privacy.canonicals == [canonical + "privacy.html"], "privacy notice needs its own canonical URL")
require("noindex" in privacy.meta.get("robots", ""), "privacy notice must not compete with the product homepage")
require("__SITE_ORIGIN__" not in (DIST / "privacy.html").read_text(), "unresolved privacy canonical placeholder")
require((DIST / "privacy.css").is_file(), "privacy notice stylesheet must be published")
for prefix in ("og", "twitter"):
    require(home.meta.get(f"{prefix}:title") == home.titles[0], f"{prefix} title must match the page")
    require(home.meta.get(f"{prefix}:description") == home.meta["description"], f"{prefix} description must match the page")
require(home.meta.get("og:site_name") == "Offscript", "social metadata needs the brand")

sitemap = ET.parse(DIST / "sitemap.xml")
require(sitemap.getroot().tag == f"{{{NS['s']}}}urlset", "sitemap needs the standard XML namespace")
urls = [node.text for node in sitemap.findall("s:url/s:loc", NS)]
require(urls == [canonical], "sitemap must list the single canonical content page, without chat or error URLs")
source_urls = [node.text for node in ET.parse(ROOT / "public/sitemap.xml").findall("s:url/s:loc", NS)]
require(len(source_urls) == len(urls), "build must preserve the source sitemap's routes")
robots = (DIST / "robots.txt").read_text()
require(f"Sitemap: {canonical}sitemap.xml" in robots, "robots.txt must advertise the canonical sitemap")
require("Disallow: /api/" in robots and "Disallow: /\n" not in robots, "allow the site but exclude API routes")
headers = (DIST / "_headers").read_text()
for route in ("/config.json", "/api/*", "/404.html"):
    require(route + "\n" in headers, f"missing indexing rule for {route}")
    block = headers.split(route + "\n", 1)[-1].split("\n/", 1)[0]
    require("X-Robots-Tag: noindex" in block, f"{route} needs a noindex response header")
print("SEO checks passed: canonical HTML, metadata, sitemap, robots and non-content indexing rules.")

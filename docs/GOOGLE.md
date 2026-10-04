# Google discovery

Publishing creates a publicly accessible HTTPS website. It does not automatically list a page in Google Search or establish a ranking.

This build includes real HTML content before JavaScript, a descriptive title and description, one canonical homepage, `robots.txt`, `sitemap.xml`, and an HTTP 404 page with `noindex`. Chats are never turned into crawlable URLs or persisted pages.

Canonical homepage: https://offscript-ephemeral.sukiasyanmher7.chatgpt.site/

Sitemap: https://offscript-ephemeral.sukiasyanmher7.chatgpt.site/sitemap.xml

To request discovery, sign into [Google Search Console](https://search.google.com/search-console), add a **URL-prefix** property using the homepage above, and choose the **HTML tag** verification method. A DNS/domain property requires DNS access to the domain; the provided subdomain is more suitable for URL-prefix verification. Add Google's exact verification meta tag to `index.html`, publish, complete verification, submit the sitemap, then inspect the homepage URL and request indexing.

No Search Console property or indexing request has been submitted in this task: account access and the exact verification token have not been supplied. Do not invent a token or claim that verification is complete.

Google says crawling can take days to weeks and requesting a crawl does not guarantee indexing. See [Google's recrawl instructions](https://developers.google.com/search/docs/crawling-indexing/ask-google-to-recrawl). A short single-purpose chat page may be indexed slowly; do not add fake content or expose private conversations for SEO.

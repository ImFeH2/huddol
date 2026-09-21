ACCESS_ERROR_PAGE = b"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Access to Huddol requires authentication</title>
<style>
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body {
  background: rgb(31 30 30); color: rgb(247 245 244);
  font: 14px/20px Inter, -apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif;
  letter-spacing: -.015em;
}
main { display: flex; min-height: 100%; padding: 24px; }
.alert {
  display: grid; grid-template-columns: 16px minmax(0, 1fr);
  gap: 2px 8px; width: 100%; max-width: 520px; margin: auto;
  padding: 12px 14px; border: 1px solid rgb(228 108 99 / 32%);
  border-radius: 12px; background: rgb(228 108 99 / 4%);
  overflow-wrap: anywhere;
}
svg { width: 16px; height: 20px; color: rgb(228 108 99); }
h1 { margin: 0; font: inherit; font-weight: 500; }
.description { grid-column: 2; display: flex; flex-direction: column; gap: 10px; }
p { margin: 0; color: rgb(175 172 171); }
</style>
</head>
<body>
<main>
<section class="alert" role="alert" aria-labelledby="title" aria-describedby="description">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
 stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
 aria-hidden="true">
<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>
</svg>
<h1 id="title">Access to Huddol requires authentication</h1>
<div class="description" id="description">
<p>The access credentials are missing or no longer valid.</p>
<p>Open Huddol from the application, or use the access link provided when Huddol starts.
That link includes the credentials needed to connect.</p>
</div>
</section>
</main>
</body>
</html>
<!--
MIT License
Copyright (c) 2025 Deepak Negi

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
-->
"""

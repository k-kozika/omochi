# Omochi OGP card

Editable source: [omochi-ogp.html](omochi-ogp.html). Open directly in a browser; no build step or network connection is needed.

- Canvas: 1200 × 630 pixels. The browser preview scales to fit the window.
- Copy: edit the HTML text nodes under `Main copy` and in the footer.
- Colors: edit the CSS variables in `:root`.
- Diagram: edit the inline SVG. This is a concept diagram, not a product screenshot.
- Fonts: uses installed Japanese sans-serif fonts, preferring Noto Sans CJK JP. Font metrics may differ on other machines.
- PNG: `omochi-ogp.png` is an export; regenerate it after editing the HTML.

To export from the repository root with Chromium:

```sh
python3 -m http.server 8000 --bind 127.0.0.1
```

Then, in another terminal:

```sh
chromium --headless --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=1 --window-size=1200,630 \
  --screenshot=docs/assets/ogp/omochi-ogp.png \
  http://127.0.0.1:8000/docs/assets/ogp/omochi-ogp.html
```

The card is authored entirely in HTML/CSS/SVG.

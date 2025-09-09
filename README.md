# JTX — Add interactivity to HTML, no framework required

JTX is a tiny library that makes a server‑rendered page feel alive. Keep writing normal HTML on the server; sprinkle a few small tags and attributes in your markup; JTX binds your JSON data to the page so it updates reactively — without a build step or a virtual DOM.

For the full, precise specification of how JTX works, see [SPEC.md](SPEC.md). This README focuses on the big picture and how to start.

**What JTX is**
- A lightweight layer you add on top of existing HTML.
- Driven by plain JSON data from your server or streams.
- Declarative: you express what should show up where; JTX updates it.
- Build‑free: just include the script; no bundlers or toolchains required.

**What JTX isn’t**
- Not a full application framework.
- Not a replacement for your server or routing.
- Not tied to a specific backend — it works with any JSON.

**Why use it**
- Keep your server‑side rendering and progressive enhancement.
- Add dynamic bits (lists, text, toggles, live updates) with minimal code.
- Stay close to the platform: it’s just HTML with a few helpful pieces.

## Quick start
1) Install or include the script
- NPM: use `npm install @angerenage/jtx` in your project directory
- CDN: add `<script src="https://unpkg.com/@angerenage/jtx"></script>` to your HTML

2) Add a tiny bit of markup
You can introduce a small state and bind it to the page. JTX keeps the text in sync when the state changes.

```html
<jtx-state name="ui" counter="0">
  <button jtx-on="click: @ui.counter++">+</button>
  <span jtx-text="@ui.counter"></span>
</jtx-state>
```

That’s the general idea: your page stays server‑rendered, and JTX wires JSON values to the parts that should react.

When to reach for JTX
- You already render HTML on the server and want small interactive touches.
- You prefer not to introduce a heavy client framework or build tooling.
- You have live/streaming JSON data and want the page to reflect it.

## Learn more
- Full spec, tags, attributes, events, and behavior: see [SPEC.md](SPEC.md).
- Example patterns and recipes can be derived from the spec.

## Status
- Version 1 spec is defined. API may evolve in minor ways as feedback comes in, but the core ideas are stable.

## Contributing
Contributions welcome! Please open issues or PRs for bugs, features, or docs.

## License
MIT License. See [LICENSE](LICENSE) for details.

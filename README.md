# JTX — Add interactivity to HTML, no framework required

JTX is a tiny library that makes a server‑rendered page feel alive. Keep writing normal HTML on the server; sprinkle a few small tags and attributes in your markup; JTX binds your JSON data to the page so it updates reactively — without a build step or a virtual DOM.

For the full, precise specification, see [SPEC.md](SPEC.md). This README is a practical "how to".

**What JTX is**
- A lightweight layer on top of your existing HTML.
- Driven by JSON from HTTP/SSE/WebSocket sources or local state.
- Declarative: add attributes/tags; JTX updates the DOM for you.
- Build‑free: include a script and you’re done.

**Why use it**
- Keep SSR and progressively enhance with minimal client code.
- Great for lists, text, toggles, and live feeds.
- Stays close to the platform — just HTML + a few helpers.

## Quick Start
- NPM: `npm install @angerenage/jtx`
- CDN: `<script src="https://unpkg.com/@angerenage/jtx"></script>`

JTX auto‑initializes on `DOMContentLoaded`. If you append HTML later, call `JTX.init(subtreeElement)`.

## Core Concepts
- `@name.path`: read values from a state or source.
- Expressions are plain JS (in attribute values).
- Event handlers use `jtx-on="event: code"`.

Helpers available in expressions and handlers:
- `emit(name, detail)`: dispatch a custom event on the current element.
- `refresh('srcName')` or `@src.refresh()`: re‑fetch a source.
- `get/post/put/patch/del(url, [bodyOrHeaders], [headers])`: thin `fetch` helpers.
- `$event`: current event in `jtx-on`.
- `$el`: current element.

## jtx‑state — Local, Mutable State
Declare a state and expose keys as data to descendants.

```html
<jtx-state name="ui" counter="0" theme="'light'" persist="theme" persist-url="counter">
  <button jtx-on="click: @ui.counter++">+</button>
  <span jtx-text="@ui.counter"></span>
</jtx-state>
```

- `name` (required): unique id.
- Any other attribute becomes a key (evaluated once at init).
- `persist`: comma‑separated keys saved to `localStorage`.
- `persist-url`: comma‑separated keys synced to query string.

Events you can listen to (they bubble):
- `init`: `{ name, value }` when created.
- `update`: `{ name, keys, value }` after batched changes.

Two‑way binding with form elements via `jtx-model`:

```html
<jtx-state name="form" email="''">
  <input type="email" jtx-model="@form.email">
  <p jtx-text="@form.email"></p>
</jtx-state>
```

Notes:
- States are scoped: a `<jtx-state>` inside a template/section shadows outer states of the same name.

## jtx‑src — Remote or Streaming Data
Fetch JSON over HTTP or stream JSON via SSE/WebSocket. Use child content to render the value.

```html
<!-- HTTP example: fetch on load and every 30s -->
<jtx-src name="orders" url="/api/orders" fetch="onload, every 30s" select="items">
  <jtx-loading>Loading…</jtx-loading>
  <jtx-error>Could not load orders.</jtx-error>
  <jtx-empty>No orders yet.</jtx-empty>

  <ul>
    <jtx-insert for="o in @orders">
      <jtx-template>
        <li>
          <span jtx-text="o.id"></span> — <span jtx-text="o.title"></span>
        </li>
      </jtx-template>
    </jtx-insert>
  </ul>
</jtx-src>
```

```html
<!-- SSE example: stream events; optionally filter with sse-event -->
<jtx-src name="feed" url="sse:/events" sse-event="tick">
  <p jtx-text="@feed.$status"></p>
</jtx-src>

<!-- WebSocket example -->
<jtx-src name="chat" url="wss:/ws/chat"></jtx-src>
```

Attributes:
- `name` (required): unique id.
- `url` (required): HTTP (`/api` or `https://…`), SSE (`sse:/path`), WS (`ws:/…` or `wss:/…`).
- `fetch`: when to fetch (HTTP only): `onload` (default), `idle`, `visible`, `every 5s`, or `manual` for manual control.
- `headers`: JSON or expression for request headers, e.g. `{ Authorization: 'Bearer ' + @auth.token }`.
- `select`: dot‑path to pick a nested value from the JSON payload.
- `sse-event`: for SSE, only handle a specific event type.

Children you can add inside a `jtx-src` (optional): `jtx-loading`, `jtx-error`, `jtx-empty`.

Programmatic refresh:
- In JS: `JTX.refresh('orders')`
- In expressions/handlers: `@orders.refresh()` or `refresh('orders')`

Source status and error are readable in expressions:
- `@orders.$status` is one of `idle | loading | ready | error`
- `@orders.$error` contains last error, if any

Events you can listen to on the `<jtx-src>` element:
- `init`: `{ name }` when registered.
- `fetch`: `{ url, headers }` before an HTTP request.
- `update`: `{ name, value }` after new data is set.
- `error`: `{ name, type, status?, message, raw? }` on network/parse/connection errors.
- `open`: `{ name, type: 'sse' | 'ws' }` when a stream opens.
- `close`: `{ name, code?, reason? }` when a stream closes.
- `message`: `{ name, type, data, lastEventId? }` for raw SSE/WS messages.

## Rendering Helpers (Attributes)
Use these attributes anywhere in your HTML:

- `jtx-if="expr"`: add/remove the element based on truthiness.
- `jtx-show="expr"`: toggle `hidden` attribute.
- `jtx-text="expr"`: set `textContent` (falls back to original content if `null/undefined`).
- `jtx-html="expr"`: set `innerHTML` (you are responsible for sanitizing).
- `jtx-attr-FOO="expr"`: bind any attribute `FOO` (boolean true => present, false/null/undefined => removed).
- `jtx-model="@state.key"`: two‑way bind form inputs/selects/textarea to state (supports nested paths like `@state.user.name`).
- `jtx-on="event: code; other: code"`: run JS on events. Also supports timers: `every 5s: code`.

## Lists and Templates — `<jtx-insert>`
Insert text/HTML or render lists with a template.

Scalar insert:
```html
Hello, <jtx-insert text="@user.name">guest</jtx-insert>!
```

List insert:
```html
<jtx-insert for="item in @orders" key="item.id" strategy="replace">
  <jtx-template>
    <div>
      <span jtx-text="item.id"></span>
      <span jtx-text="item.title"></span>
    </div>
  </jtx-template>
</jtx-insert>
```

Options:
- `for` (required for lists): `item in <expr>` or `value,key in <expr>`.
- `key`: stable key per item (recommended).
- `strategy`: `replace` (default), `append`, or `prepend` for streaming/accumulating data.
- `window`: with `append`/`prepend`, optionally cap the number of rendered items.
- Optional children: `jtx-loading`, `jtx-error`, `jtx-empty` (useful when nested under a `jtx-src`).

## Initialization Hooks
- Auto‑init on page load. To initialize a dynamically inserted subtree: `JTX.init(element)`.
- Attributes inside `<jtx-template>` are compiled per item when the list renders.

## Tips
- Keep expressions simple and safe; they run in the browser.
- Prefer `select` on `jtx-src` to avoid repeating deep paths in templates.
- Unknown `@name` references warn in the console; check your `name` attributes.

## Learn More
- Detailed behavior, edge cases, and full semantics: see [SPEC.md](SPEC.md).

## License
MIT — see [LICENSE](LICENSE).

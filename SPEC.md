# **JTX v1 specification**

## **Introduction**

JTX is a minimal client‑side library designed to add interactivity to an already server‑rendered HTML document. It treats HTML as a template and JSON as the state: the server sends a static page; JTX binds data from sources and states into that markup to update the page reactively. It does **not** aim to be a full application framework; instead, it enhances existing markup without requiring a build step or a virtual DOM.

JTX uses a few custom HTML elements (`jtx-state`, `jtx-src`, `jtx-insert`) and a set of declarative attributes (`jtx-if`, `jtx-text`, `jtx-on`, etc.). Data is addressed via the `@name.path` syntax, where name refers to a state or source. Expressions are plain JavaScript evaluated in a restricted context (initially via eval, with the possibility of a sandbox in later versions). JTX expects that all data fetched from the network or received via streaming is JSON; empty responses (HTTP 204 or empty event bodies) are interpreted as null.

This document describes version 1 of JTX: how the tags and attributes behave, how data flows through the system, what events they emit, and how to hook into those events to implement interactive behaviour.

## **1. Data addressing and expressions**

Data is always accessed through a **definition name**. Two kinds of definitions exist:

- **States** (defined with `<jtx-state>`): mutable stores local to a part of the document.  
- **Sources** (defined with `<jtx-src>`): read‑only stores whose values come from HTTP requests, Server‑Sent Events (SSE) or WebSocket streams.

A reference takes the form `@name.path`:

- name must correspond to the name attribute of a `jtx-state` or `jtx-src`.  
- path is optional and, when present, can be a dotted or indexed access: `items[0].title`.

If no path is given, the entire state or source value is returned.

### **Contextual variables**

Inside list iterations (`jtx-insert for="item,key in @orders"`), the following special variables are available:

- `$` – the current item.  
- `$index` – the zero‑based index of the current item (or the key when iterating an object).  
- `$key` – the key after coercion to a string.  
- `$root` – the value of the expression passed to for.  
- `$event` – inside event handlers, refers to the event object.

## **2. Definitions**

### **2.1. \<jtx-state>**

The `<jtx-state>` element declares a mutable store whose keys and values are available to descendant nodes. Its purpose is to hold UI state (form inputs, toggles, etc.). It never fetches data by itself; values are provided via its attributes or mutated via handlers.

**Attributes**

- name (**required**). A unique identifier in the document.  
- Any other attribute becomes a **key** in the state; its value is evaluated once during initialisation. For example, `<jtx-state name="ui" counter="0" theme="'light'"></jtx-state>`
creates a state @ui with properties `counter = 0` and `theme = "light"`.
- persist (*optional*). A comma‑separated list of keys that should be stored in localStorage. On page load, the library checks localStorage for these keys and overrides the default value if present.
- persist-url (*optional*). A comma‑separated list of keys that should be serialised into the URL query string. When the page loads, if the URL contains those keys, they override the default values. When the state changes, the URL is updated.

**Usage**

State values are read with `@name.key`. They are mutated only within handlers (*see §5*) using assignment or increment/decrement operations. Example:

```html
<jtx-state name="ui" counter="0">
  <button jtx-on="click: @ui.counter++">+</button>
  <span jtx-text="@ui.counter"></span>
</jtx-state>
```

Mutations are batched: all state changes within a frame trigger a single re‑render of the dependent attributes. State shadowing is lexical: inner states hide keys of outer states.

**Events**

jtx-state instances dispatch custom events that bubble through the DOM. You can listen to them with jtx-on:

| Event | Trigger | Details |
| :---- | :---- | :---- |
| init | When the state is created and its default values have been evaluated. | `{ name: stateName,  value: initialState }` |
| update | After one or more keys are mutated. | `{ name: stateName, keys: [changedKey], value: currentState }` |
| error | When evaluating a default value or restoring a persisted value throws. | `{ name: stateName, error }` |

Example of handling an update:

```html
<jtx-state name="ui" counter="0" jtx-on="update: console.log('ui changed', $event.detail)"></jtx-state>
```

### **2.2. \<jtx-src>**

The `<jtx-src>` element defines a **read‑only source** whose value comes from HTTP, SSE or WebSocket. Its children can display the value and react to changes. A source does not mutate its own value except in response to network events.

**Required attributes**

- `name` – unique identifier.
- `url` – endpoint or stream:
  - HTTP: a path like /api/orders or a full URL https://...
  - SSE: prefix with sse: (e.g. sse:/stream). The actual URL is after the sse: prefix.
  - WebSocket: prefix with ws: or wss:.

**Optional attributes**

- `fetch` – defines when and how the source fetches:
  - `onload` (*default*): fetch once after the element is connected.
  - `manual`: do not fetch automatically; call @name.refresh() to fetch.
  - `visible`: fetch when the element scrolls into view (requires IntersectionObserver).
  - `idle`: fetch after the page becomes idle.
  - `every <duration>`: poll periodically; e.g. `every 1s`.
  - Combinations separated by comma: `onload, every 10s`.
- `headers` – JSON‑encoded object of HTTP headers.
- `select` – dot‑notation path to extract from the parsed JSON. For example `select="data.items"` means `@src` will be `parsedJson.data.items`.
- `sse-event` – for SSE sources only: a single event type to listen for. If omitted, **all** SSE events update the source. Each event's data is parsed as JSON.

**Data parsing**

jtx assumes that **all responses or messages are JSON**:

- HTTP 204 (no content) or empty response body results in @name = null.
- Otherwise jtx tries to JSON.parse the body. On success the parsed value is assigned to @name. If parsing fails, jtx sets @name.$error and does not change the value.

For SSE/WS:

- If event.data (SSE) or the WebSocket message is an empty string, the value becomes null.
- Otherwise jtx tries to parse the string as JSON. If parsing fails, the source's error event fires and the value is not changed.

After JSON parsing, jtx applies select if provided. The resulting value becomes @name.

**Manual refresh**

Call @name.refresh() in a handler to trigger a fetch. For SSE/WS sources this resubscribes the stream.

**Events**

jtx-src dispatches several events:

| Event | Trigger | Detail |
| :---- | :---- | :---- |
| init | When the source element is initialised (before any fetch/stream). | `{ name }` |
| fetch | Immediately before starting an HTTP fetch. | `{ url, headers }` |
| open | When an SSE or WebSocket connection opens. | `{ name, type: 'sse' \| 'ws' }` |
| message | For each SSE event or WS message, before parsing. | `{ name, type, data, lastEventId? }` |
| update | After the source's value has been set (from HTTP, SSE or WS). | `{ name, value }` |
| error | On HTTP network error, SSE/WS error or JSON parse error. | `{ name, type: 'network' \| 'format' \| 'connection', status?, message, raw? }` |
| close | When an SSE or WS connection closes. | `{ name, code?, reason? }` |

SSE event types are not mapped to event names by default. Use sse-event to filter to a single type; otherwise message fires for every SSE event. But by specifying an event name as a trigger, only that event will fire the code, even if it is not the listened sse-event.

You can react to these events via jtx-on:

```html
<jtx-src name="tick" url="sse:/feed" jtx-on="message: console.log('raw event',$event.detail); update: @ui.lastTick = @tick; error: console.error($event.detail)"></jtx-src>
```

### **2.3. \<jtx-insert>**

The `<jtx-insert>` element fills its slot with either **text** or a **list** of elements derived from a JSON array or object. Each insert maintains its own internal state describing the current rendered items; this makes it possible to accumulate or merge data over time even though the source value is replaced on each update.

#### **2.3.1 Scalar insert**

By default, when inserting a scalar, the current contents of the jtx-insert are replaced with the new one. It can be used to display temporary messages or values before data retrieval.

Attributes:

- `text` – expression whose result is converted to text and set as textContent.
- `html` – expression whose result is inserted as HTML. You are responsible for sanitising it if necessary.

Example:

```html
<p>Hello, <jtx-insert text="@user.name ?? 'unknown'"/></p>

<p>Hello, <jtx-insert text="@user.name">unknown</jtx-insert>!</p>
```

#### **2.3.2 List insert**

Attributes:

- for (**required**):  
  - `item in <expr>` iterates over an array; item is the item, $index is its index.  
  - `value,key in <expr>` iterates over an object; value is the value, $index is the key.

If `<expr>` yields null, undefined or any non‑iterable value, it is coerced to a single‑element array `[<expr>]`. This allows a list to start with a single object and subsequently accumulate more items when new data arrives (e.g. via SSE).

- key (*recommended*) – expression that yields a **stable string key** for each item. jtx uses this to identify DOM nodes when updating. If absent, the insert falls back to the current index or object key, which is not stable across updates.  
- strategy (*optional*) – how to handle successive evaluations and updates. Options:  
  - replace: **Removes** all current items and inserts the new ones from scratch. Emits remove for the previously present keys, then add for the new items.
  - append: Adds the new items to the end, always. Applies window trimming (from the start), emitting remove for trimmed items.
  - prepend: Adds the new items to the beginning, always (no de-dup by key). Applies window trimming (from the end) if configured, emitting remove.
  - merge (after append or prepend): Replaces existing items by index and appends/prepend extra items; leaves others intact. Emits update for changed items, add for new items. Window as append/prepend.

- window (**required if strategy is not replace**) – integer specifying a window size. For example, window="200" keeps at most 200 items in the list. Items beyond are dropped from the state and DOM when new items arrive. This allows uncontrolled feeds to remain performant.

Children:

- **One `<jtx-template>` (required)**. It is used to create DOM nodes for each item. The template must have exactly one root element; that element becomes the child of `<jtx-insert>`. Inside the template you can use `jtx-*` attributes to bind values. jtx handles keys via the key attribute of `<jtx-insert>`.
- Optional slots: `<jtx-loading>`, `<jtx-error>`, `<jtx-empty>`. These appear only when the parent context (usually a `<jtx-src>` or `<jtx-state>`) is loading, in error, or empty. They are mutually exclusive with the normal template rendering.

**Events**

jtx-insert dispatches events as its internal list changes:

| Event | Trigger | Detail |
| :---- | :---- | :---- |
| init | After the insert renders its first item(s). | `{ name?, count }` |
| add | When new keys are added (merge, append or prepend). | `{ items: [values] }` |
| update | When existing items are updated (any strategy) or moved. | `{ items: [values] }` |
| remove | When keys are removed (replace or due to window trimming). | `{ keys: [keyStrings] }` |
| empty | When the internal list becomes empty. | `{ }` |
| error | If evaluating for or key throws, or if duplicate/undefined keys occur. | `{ error }` |
| clear | When the insert is disconnected from the DOM (e.g. removed). | `{ }` |

The internal state of a `<jtx-insert>` – its current map or list – is **not exposed via @...**. If you need to inspect or mutate it, implement that logic in your handlers.

## **3. Declarative attributes**

### **3.1 Conditional and textual attributes**

- `jtx-if="<expr>"`: if the expression is truthy, the element remains in the DOM; if falsy, jtx removes the element from the DOM entirely (not merely hides it). Use this to include or exclude markup.
- `jtx-show="<expr>"`: toggles the hidden attribute on the element. Use this to hide an element without removing it (e.g. to preserve focus).
- `jtx-text="<expr>"`: assigns the expression's result (converted to a string) to textContent. Equivalent to `<jtx-insert text="…">` but directly on the element.  
- `jtx-html="<expr>"`: inserts the expression's result as HTML inside the element. You must ensure that the HTML is safe to insert.
- `jtx-attr-*="<expr>"`: sets the real HTML attribute `*` to the evaluated result. If the result is false, null or undefined, jtx removes the attribute. If the result is true, jtx sets a boolean attribute with no value.

### **3.2 Model binding**

- `jtx-model="@state.key"` attaches two‑way binding to `<input>`, `<textarea>` or `<select>` elements. When the element fires input or change, jtx writes its value to the specified state key; when the state key changes, jtx updates the element's value. You can override the update event types by using `jtx-on`.

Example:

```html
<input jtx-model="@ui.query" placeholder="Search…">  
<p>Searching for: <span jtx-text="@ui.query"></span></p>
```

### **3.3 Handlers (jtx-on)**

jtx-on attaches event listeners to an element. The syntax is:

`eventName : statement ; eventName2 : statement2 ; ...`

Whitespace is ignored. Event names correspond to:

- **Native DOM events** (e.g. `click`, `input`, `submit`).  
- **Custom events dispatched by jtx** (see §2.1, §2.2, §2.3).  
- **Custom events you emit yourself** (see below).  
- **Custom periodic events defined with** `every <duration>` (same as for fetch); e.g. `every 1s`.

A **statement** is a JavaScript‑like sequence of expressions or actions separated by `;`. jtx evaluates them in order. Statements can use:

- Expressions, whose values are ignored unless used in an assignment.
- Assignments to state keys: `@ui.counter++`, `@ui.name = $el.value`.
- Function calls to jtx utilities (e.g. `refresh(@orders)`) or your own functions.
- `post("/api/x", {...})`, `get(...)`, `put(...)`, `patch(...)`, `del(...)` – network actions; you implement these to return promises. jtx awaits their completion before continuing.
- `emit("name", { any: data })`– dispatches a custom event with the given name. Event bubbles like a normal DOM event. Handlers can catch it by specifying the event name in jtx-on.

You can reference `$event` inside a handler: it is the current event object. If you mutate state inside a handler, jtx batches re‑renders until the handler finishes.

Example:

```html
<button jtx-on="click: @ui.counter++; emit('counter:changed', {value: @ui.counter})">  
  Increment  
</button>  
<p jtx-on="counter:changed: console.log('new value', $event.detail.value)"></p>
```

## **4. Persistence to URL**

Use the persist-url attribute on `<jtx-state>` to synchronise selected keys to the URL's query string:

```html
<jtx-state name="ui" q="''" filters="{}" persist-url="q,filters"></jtx-state>
```

jtx initialises the state by reading ?q=…\&filters=… from location.search (values are decoded from JSON). When @ui.q or @ui.filters changes, jtx serialises them back into the query string without reloading the page. This enables shareable, bookmarkable UI state without writing any imperative code.

## **5. Error handling**

If a network error occurs (HTTP non‑2xx, SSE/WS connection error, parse error), jtx sets `@srcName.$status = "error"` and `@srcName.$error` to an object describing the error, and dispatches an error event on the `<jtx-src>`. It does **not** clear the current value of the source. Use `<jtx-error>` inside a `<jtx-src>` or `jtx-on="error: …"` to display or react to the error.

For `<jtx-insert>`, if evaluation of for or key throws or yields duplicate/undefined keys, jtx does not modify the DOM and fires the error event on the insert.

## **6. Security considerations**

In version 1, expressions and handlers are evaluated with eval. You must ensure that the data and expressions you use are trustworthy. In future versions a restricted interpreter may be used. Always sanitise untrusted HTML inserted via jtx-html. Do not reference global objects like window or document in expressions.

## **7. Examples**

### **SSE feed with append strategy**

```html
<jtx-state name="ui" feedOpen="false">
  <jtx-src name="events" url="sse:/news" sse-event="news">

    <button jtx-on="click: @ui.feedOpen = !@ui.feedOpen; @events.refresh()">
      Toggle feed  
    </button>

    <ul>
      <jtx-insert for="e in @events" key="e.id" strategy="append" window="10">
        <jtx-template>
          <li jtx-text="e.title"></li>
        </jtx-template>
        <jtx-error>Error: <span jtx-text="@events.$error.message"></span></jtx-error>
        <jtx-empty>No news yet</jtx-empty>
      </jtx-insert>
    </ul>
  </jtx-src>
</jtx-state>
```

Each SSE event updates `@events` with a new object. Because the insert's strategy is append, the list grows (up to 10 items) as events arrive.

### **Polling with merge strategy and window**

```html
<jtx-src name="orders" url="/api/orders/updates" fetch="onload, every 2s">
  <ul>
    <jtx-insert for="o in @orders" key="o.id" strategy="merge" window="100">
      <jtx-template>
        <li>
          <a jtx-attr-href="o.url" jtx-text="o.title"></a>
          <small jtx-text="o.status"></small>
        </li>
      </jtx-template>
    </jtx-insert>
  </ul>
</jtx-src>
```

This list starts empty. Every response from `/api/orders/updates` contains a subset of orders: the insert upserts them into its internal map. The window option limits rendering to at most 100 items.

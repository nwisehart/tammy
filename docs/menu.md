# The menu

The menu is the product's documentation, the only thing Tammy answers from. It
is indexed into her SQLite file ahead of time, so answering a question costs
one local search and no network.

## Sources

`[[menu.sources]]` in `tammy.toml`, any number of them, each a local path or a
web address:

```toml
[[menu.sources]]
path = "../prepcook-demo/docs"     # a directory: every Markdown, text, HTML and PDF file in it
include = ["**/*.md"]              # optional: only these patterns

[[menu.sources]]
path = "../handbook/**/*.md"       # a glob

[[menu.sources]]
url = "https://docs.example.com/"  # a start page
depth = 2                          # levels of links followed; 0 reads only that page
include = ["/guide/"]              # optional: path prefixes the crawl stays within
```

- **Local files**: Markdown (`.md`, `.markdown`, `.mdx`), plain text, HTML and
  PDF. `node_modules/` and `.git/` are skipped. A document's title is its first
  `#` heading, else its file name.
- **Web pages** are crawled breadth-first from the start page, on the start
  page's origin only, never more than 500 pages. HTML is turned into text with
  its headings kept and navigation, headers, footers and scripts dropped; a
  heading's `id` becomes its anchor. Text and PDF responses are read as well.
- **PDF** needs the optional `unpdf` package (a development dependency here;
  `pnpm add unpdf` in a production install). Without it a PDF is skipped with
  a warning. Each page becomes a section, cited as `Page 3`.

## Indexing

```sh
pnpm tammy index                         # the sources in tammy.toml
pnpm tammy index ../prepcook-demo/docs   # just these paths or URLs
pnpm tammy index --full                  # re-embed everything
pnpm tammy index --watch                 # then re-index local sources when a file changes
```

Each document is split at its headings; a section longer than
`menu.chunk_tokens` (500 by default, at about four characters a token) is cut
on paragraph, then sentence, boundaries, and consecutive chunks of one section
share `menu.overlap_tokens` (60) so an answer that straddles a cut is still
found. A chunk never spans two sections, so each has one heading to cite. The
heading trail (`Sharing a list › Sharing a list with someone`) is embedded with
the text.

Indexing is incremental: a document is re-embedded only when its content hash
changed (the hash covers the chunk settings too). A document that is gone is
dropped — except under a source that could not be read at all this time, whose
documents are kept until it can.

### Embeddings

Anthropic has no embeddings API, so the menu is embedded on this machine with
a small sentence model, `Xenova/all-MiniLM-L6-v2` (384 dimensions, about 25 MB
quantised) through `@xenova/transformers`. The first `tammy index` downloads it
from Hugging Face into `<data_dir>/models`; after that nothing goes online,
and the running server never downloads it (it tells you to run `tammy index`
instead).

- **Behind a proxy**, Node's `fetch` ignores `HTTPS_PROXY` unless told:
  `NODE_USE_ENV_PROXY=1 pnpm tammy index` (Node 22.21 or later).
- **No internet at all**: copy the model's directory from a machine that has
  it (`<data_dir>/models/Xenova/all-MiniLM-L6-v2`) and point
  `menu.embeddings.local_dir` at the folder above it.
- **`model = "builtin:hash"`** needs no model: each word is hashed into a
  vector. It finds passages that share words with the question, not ones that
  mean the same thing, so use it for trying Tammy out and for CI, not for
  customers.

Changing the model rebuilds the index on the next `tammy index`; until then
the server refuses to search an index built with another model rather than
return nonsense.

The vectors live in a `sqlite-vec` table in `<data_dir>/tammy.db`, beside the
documents and chunks they came from, and are compared by cosine similarity.

## Retrieval

`search_menu` returns the `menu.top_k` (5) nearest chunks. When even the best
scores below `menu.min_score` (0.35), the result is **thin**: Tammy is told the
menu probably does not cover the question, and she says she does not know and
offers to ask the team. Raise `min_score` if she answers from loosely related
passages; lower it if she gives up on questions the menu does answer.
`tammy ask` shows the scores.

```sh
pnpm tammy ask "how do I share a list"
```

prints each passage with its score, heading trail and citation, then Tammy's
answer when `ANTHROPIC_API_KEY` is set. Without a key it says so and stops:
nothing goes to Slack, Claude or Prepcook.

## What she cites

Tammy numbers the passages she used, and each answer ends with where they came
from:

- a passage from a **web page** is a link to its section
  (`https://docs.example.com/guide/sharing#share`), labelled with the heading;
- a passage from a **local file** reads _from the menu: Sharing a list with
  someone_ — the heading, since a customer cannot open a file on Tammy's
  machine. `tammy ask` and the logs show the file, anchor and line
  (`docs/sharing.md#sharing-a-list-with-someone (line 8)`).

Only passages the answer actually cites are listed, renumbered in the order
they are used. Publishing the docs on the web and indexing them by URL gives
customers links they can follow.

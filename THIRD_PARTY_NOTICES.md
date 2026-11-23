# Third-party notices

MemCode includes third-party software and fonts. These components retain their
own licenses; MemCode's noncommercial terms do not restrict rights granted by
those licenses. The original notices are supplied in [third_party/licenses](third_party/licenses)
and [third_party/upstream](third_party/upstream). The inventory records exact
provenance and SHA-256 hashes. Nested notices for bundled fonts, PDF/WASM codecs
and other resource files are retained alongside package-level notices.

This inventory covers resolved production npm and Cargo lockfile dependencies,
including platform-specific and build-only crates. It is deliberately broader
than the code linked into any one installer. License alternatives are preserved;
MemCode uses permissive alternatives such as MIT where offered, rather than GPL
or LGPL alternatives. Conjunctive licenses remain conjunctive.

## Separately licensed Memtrace engine

Windows setup also embeds Microsoft's signed Evergreen WebView2 Runtime offline
installer. It installs the Windows webview prerequisite when needed; Windows
continues to update that shared runtime. It is separately licensed by Microsoft:
[WebView2 distribution](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution).
The Microsoft installer retains its original publisher signature and notices.

Official MemCode desktop installers include a tested compiled Memtrace engine.
Its original archive and reviewed checksums are supplied in `memtrace-engine/`;
the unchanged license, beta usage terms, dependency notices and build provenance
are also available in `memtrace-engine/notices/`. The engine is separately
licensed and is not covered by MemCode's PolyForm Noncommercial license. No
Memtrace or MemDB backend source is included. The app activates the private
engine after account approval without replacing an installed Memtrace CLI.

## Optional local inference and dictation

The separately staged `retriever-runtime/` resources contain a text-only build
of Transformers.js 4.3.2 and ONNX Runtime 1.23.2. Original package notices remain
beside those components; `THIRD_PARTY_NOTICES.json` and `provenance.json` record
their versions, notice files and checksums. The Transformers.js entry is modified
at build time to expose text generation only. Sharp, libvips and browser inference
runtimes are excluded. These independently licensed components retain their
original rights, including commercial use under their respective licenses.

Local retrieval model files are downloaded only during explicit setup. Qwen2.5
Coder 0.5B retains its Apache-2.0 license and original model card in the private
model cache. Local dictation downloads Whisper Tiny and a separately licensed
whisper.cpp CPU runtime; the Mac archive includes original dependency notices
and exact upstream source provenance. These model and runtime licenses are
separate from MemCode's noncommercial terms.

## Source access for MPL components

The unmodified MPL-2.0 components listed below remain available under MPL-2.0.
Their exact-version source is available at each Source link. In particular,
mtx-decompressor 1.8.1 source is pinned to upstream commit
d4a554a4ea8126aac0ab00a1fe8253e0ffd316d4. Source rights granted by MPL-2.0
remain available, including commercial use of those components. No proprietary
Memtrace or MemDB implementation is included by these notices.

## Bundled PDF resources

PDF.js 6.5.438 also supplies separately licensed CMaps, ICC profiles,
fonts and WASM codecs. Their complete original notices are in
[its resource notice directory](third_party/licenses/npm/pdfjs-dist-6.5.438).
The package-level Apache license does not replace these resource licenses.

The Liberation Sans font files identify themselves as version 1.07.4. They
retain the original GPL v2 Liberation-font terms and exceptions in
[LICENSE_LIBERATION](third_party/licenses/npm/pdfjs-dist-6.5.438/standard_fonts/LICENSE_LIBERATION).
MemCode copies these font resources unchanged from PDF.js; its noncommercial
restriction does not apply to the fonts. Their corresponding SFD source and
build instructions are included in the unmodified
[Liberation 1.07.4 source archive](third_party/sources/liberation-fonts-1.07.4.tar.gz).
The original source archive checksum matches the Debian source descriptor,
recorded in [resources.json](third_party/resources.json).

Optional Node-only native canvas packages appear in the lockfile inventory,
but their native binaries are not part of MemCode's configured renderer/runtime
resources. Their upstream project notice is retained for completeness.

worker-f 0.1.24 declares MIT and authorship but publishes no LICENSE file.
Its exact pinned upstream [package declaration](third_party/upstream/npm/worker-f-0.1.24/package.json)
is preserved together with unmodified generic SPDX MIT text. No missing
copyright holder or year has been invented. The original project LICENSE
added upstream for react-remove-scroll-bar is also retained, with its exact
commit and provenance in the inventory.

## Dependency inventory

| Ecosystem | Component | Version | License expression | Source |
| --- | --- | --- | --- | --- |
| cargo | adler2 | 2.0.1 | 0BSD OR MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/adler2/2.0.1/download) |
| cargo | aes | 0.9.4 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/aes/0.9.4/download) |
| cargo | aho-corasick | 1.1.5 | Unlicense OR MIT | [Source](https://crates.io/api/v1/crates/aho-corasick/1.1.5/download) |
| cargo | alloc-no-stdlib | 3.0.0 | BSD-3-Clause | [Source](https://crates.io/api/v1/crates/alloc-no-stdlib/3.0.0/download) |
| cargo | alloc-stdlib | 0.3.0 | BSD-3-Clause | [Source](https://crates.io/api/v1/crates/alloc-stdlib/0.3.0/download) |
| cargo | android_system_properties | 0.1.6 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/android_system_properties/0.1.6/download) |
| cargo | anyhow | 1.0.104 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/anyhow/1.0.104/download) |
| cargo | apple-native-keyring-store | 1.0.2 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/apple-native-keyring-store/1.0.2/download) |
| cargo | async-broadcast | 0.7.2 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/async-broadcast/0.7.2/download) |
| cargo | async-channel | 2.5.0 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/async-channel/2.5.0/download) |
| cargo | async-executor | 1.14.1 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/async-executor/1.14.1/download) |
| cargo | async-io | 2.6.0 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/async-io/2.6.0/download) |
| cargo | async-lock | 3.5.0 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/async-lock/3.5.0/download) |
| cargo | async-process | 2.5.0 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/async-process/2.5.0/download) |
| cargo | async-recursion | 1.2.0 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/async-recursion/1.2.0/download) |
| cargo | async-signal | 0.2.14 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/async-signal/0.2.14/download) |
| cargo | async-task | 4.7.1 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/async-task/4.7.1/download) |
| cargo | async-trait | 0.1.92 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/async-trait/0.1.92/download) |
| cargo | atk-sys | 0.18.2 | MIT | [Source](https://crates.io/api/v1/crates/atk-sys/0.18.2/download) |
| cargo | atk | 0.18.2 | MIT | [Source](https://crates.io/api/v1/crates/atk/0.18.2/download) |
| cargo | atomic-waker | 1.1.2 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/atomic-waker/1.1.2/download) |
| cargo | autocfg | 1.5.1 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/autocfg/1.5.1/download) |
| cargo | base64 | 0.21.7 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/base64/0.21.7/download) |
| cargo | base64 | 0.23.1 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/base64/0.23.1/download) |
| cargo | bit-set | 0.11.1 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/bit-set/0.11.1/download) |
| cargo | bit-set | 0.8.0 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/bit-set/0.8.0/download) |
| cargo | bit-vec | 0.10.2 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/bit-vec/0.10.2/download) |
| cargo | bit-vec | 0.8.0 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/bit-vec/0.8.0/download) |
| cargo | bitflags | 1.3.2 | MIT/Apache-2.0 | [Source](https://crates.io/api/v1/crates/bitflags/1.3.2/download) |
| cargo | bitflags | 2.13.2 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/bitflags/2.13.2/download) |
| cargo | block-buffer | 0.10.4 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/block-buffer/0.10.4/download) |
| cargo | block-buffer | 0.12.1 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/block-buffer/0.12.1/download) |
| cargo | block-padding | 0.4.2 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/block-padding/0.4.2/download) |
| cargo | block2 | 0.6.2 | MIT | [Source](https://crates.io/api/v1/crates/block2/0.6.2/download) |
| cargo | blocking | 1.7.0 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/blocking/1.7.0/download) |
| cargo | brotli-decompressor | 6.3.1 | BSD-3-Clause/MIT | [Source](https://crates.io/api/v1/crates/brotli-decompressor/6.3.1/download) |
| cargo | brotli | 9.1.1 | BSD-3-Clause AND MIT | [Source](https://crates.io/api/v1/crates/brotli/9.1.1/download) |
| cargo | bs58 | 0.5.1 | MIT/Apache-2.0 | [Source](https://crates.io/api/v1/crates/bs58/0.5.1/download) |
| cargo | bumpalo | 3.20.4 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/bumpalo/3.20.4/download) |
| cargo | bytemuck | 1.25.2 | Zlib OR Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/bytemuck/1.25.2/download) |
| cargo | byteorder-lite | 0.1.0 | Unlicense OR MIT | [Source](https://crates.io/api/v1/crates/byteorder-lite/0.1.0/download) |
| cargo | byteorder | 1.5.0 | Unlicense OR MIT | [Source](https://crates.io/api/v1/crates/byteorder/1.5.0/download) |
| cargo | bytes | 1.12.1 | MIT | [Source](https://crates.io/api/v1/crates/bytes/1.12.1/download) |
| cargo | cairo-rs | 0.18.5 | MIT | [Source](https://crates.io/api/v1/crates/cairo-rs/0.18.5/download) |
| cargo | cairo-sys-rs | 0.18.2 | MIT | [Source](https://crates.io/api/v1/crates/cairo-sys-rs/0.18.2/download) |
| cargo | camino | 1.2.6 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/camino/1.2.6/download) |
| cargo | cargo_metadata | 0.19.2 | MIT | [Source](https://crates.io/api/v1/crates/cargo_metadata/0.19.2/download) |
| cargo | cargo_toml | 1.0.1 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/cargo_toml/1.0.1/download) |
| cargo | cargo-platform | 0.1.9 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/cargo-platform/0.1.9/download) |
| cargo | cbc | 0.2.1 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/cbc/0.2.1/download) |
| cargo | cc | 1.11.2 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/cc/1.11.2/download) |
| cargo | cesu8 | 1.1.0 | Apache-2.0/MIT | [Source](https://crates.io/api/v1/crates/cesu8/1.1.0/download) |
| cargo | cfb | 0.14.0 | MIT | [Source](https://crates.io/api/v1/crates/cfb/0.14.0/download) |
| cargo | cfg_aliases | 0.1.1 | MIT | [Source](https://crates.io/api/v1/crates/cfg_aliases/0.1.1/download) |
| cargo | cfg_aliases | 0.2.2 | MIT | [Source](https://crates.io/api/v1/crates/cfg_aliases/0.2.2/download) |
| cargo | cfg-expr | 0.15.8 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/cfg-expr/0.15.8/download) |
| cargo | cfg-if | 1.0.5 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/cfg-if/1.0.5/download) |
| cargo | chrono | 0.4.45 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/chrono/0.4.45/download) |
| cargo | cipher | 0.5.2 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/cipher/0.5.2/download) |
| cargo | cmov | 0.5.4 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/cmov/0.5.4/download) |
| cargo | combine | 4.6.9 | MIT | [Source](https://crates.io/api/v1/crates/combine/4.6.9/download) |
| cargo | concurrent-queue | 2.5.0 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/concurrent-queue/2.5.0/download) |
| cargo | const-oid | 0.10.3 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/const-oid/0.10.3/download) |
| cargo | constant_time_eq | 0.6.1 | CC0-1.0 OR MIT-0 OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/constant_time_eq/0.6.1/download) |
| cargo | cookie | 0.18.2 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/cookie/0.18.2/download) |
| cargo | core-foundation-sys | 0.8.7 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/core-foundation-sys/0.8.7/download) |
| cargo | core-foundation | 0.10.1 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/core-foundation/0.10.1/download) |
| cargo | core-foundation | 0.9.4 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/core-foundation/0.9.4/download) |
| cargo | core-graphics-types | 0.2.0 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/core-graphics-types/0.2.0/download) |
| cargo | core-graphics | 0.25.0 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/core-graphics/0.25.0/download) |
| cargo | cpubits | 0.1.1 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/cpubits/0.1.1/download) |
| cargo | cpufeatures | 0.2.17 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/cpufeatures/0.2.17/download) |
| cargo | cpufeatures | 0.3.1 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/cpufeatures/0.3.1/download) |
| cargo | crc32fast | 1.5.5 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/crc32fast/1.5.5/download) |
| cargo | crossbeam-channel | 0.5.17 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/crossbeam-channel/0.5.17/download) |
| cargo | crossbeam-utils | 0.8.23 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/crossbeam-utils/0.8.23/download) |
| cargo | crypto-common | 0.1.7 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/crypto-common/0.1.7/download) |
| cargo | crypto-common | 0.2.2 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/crypto-common/0.2.2/download) |
| cargo | cssparser-macros | 0.7.1 | MPL-2.0 | [Source](https://crates.io/api/v1/crates/cssparser-macros/0.7.1/download) |
| cargo | cssparser | 0.37.0 | MPL-2.0 | [Source](https://crates.io/api/v1/crates/cssparser/0.37.0/download) |
| cargo | cssparser | 0.38.0 | MPL-2.0 | [Source](https://crates.io/api/v1/crates/cssparser/0.38.0/download) |
| cargo | ctor | 1.0.14 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/ctor/1.0.14/download) |
| cargo | ctutils | 0.4.8 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/ctutils/0.4.8/download) |
| cargo | darling_core | 0.24.1 | MIT | [Source](https://crates.io/api/v1/crates/darling_core/0.24.1/download) |
| cargo | darling_macro | 0.24.1 | MIT | [Source](https://crates.io/api/v1/crates/darling_macro/0.24.1/download) |
| cargo | darling | 0.24.1 | MIT | [Source](https://crates.io/api/v1/crates/darling/0.24.1/download) |
| cargo | dbus | 0.9.12 | Apache-2.0/MIT | [Source](https://crates.io/api/v1/crates/dbus/0.9.12/download) |
| cargo | deranged | 0.5.9 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/deranged/0.5.9/download) |
| cargo | derive_more-impl | 2.1.1 | MIT | [Source](https://crates.io/api/v1/crates/derive_more-impl/2.1.1/download) |
| cargo | derive_more | 2.1.1 | MIT | [Source](https://crates.io/api/v1/crates/derive_more/2.1.1/download) |
| cargo | digest | 0.10.7 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/digest/0.10.7/download) |
| cargo | digest | 0.11.3 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/digest/0.11.3/download) |
| cargo | dirs-sys | 0.5.0 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/dirs-sys/0.5.0/download) |
| cargo | dirs | 7.0.0 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/dirs/7.0.0/download) |
| cargo | dispatch2 | 0.3.1 | Zlib OR Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/dispatch2/0.3.1/download) |
| cargo | displaydoc | 0.2.7 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/displaydoc/0.2.7/download) |
| cargo | dlib | 0.5.3 | MIT | [Source](https://crates.io/api/v1/crates/dlib/0.5.3/download) |
| cargo | dlopen2_derive | 0.4.3 | MIT | [Source](https://crates.io/api/v1/crates/dlopen2_derive/0.4.3/download) |
| cargo | dlopen2 | 0.8.2 | MIT | [Source](https://crates.io/api/v1/crates/dlopen2/0.8.2/download) |
| cargo | dom_query | 0.28.0 | MIT | [Source](https://crates.io/api/v1/crates/dom_query/0.28.0/download) |
| cargo | dom_query | 0.29.0 | MIT | [Source](https://crates.io/api/v1/crates/dom_query/0.29.0/download) |
| cargo | downcast-rs | 1.2.1 | MIT/Apache-2.0 | [Source](https://crates.io/api/v1/crates/downcast-rs/1.2.1/download) |
| cargo | dpi | 0.1.2 | Apache-2.0 AND MIT | [Source](https://crates.io/api/v1/crates/dpi/0.1.2/download) |
| cargo | dtoa-short | 0.3.5 | MPL-2.0 | [Source](https://crates.io/api/v1/crates/dtoa-short/0.3.5/download) |
| cargo | dtoa | 1.0.11 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/dtoa/1.0.11/download) |
| cargo | dunce | 1.0.5 | CC0-1.0 OR MIT-0 OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/dunce/1.0.5/download) |
| cargo | dyn-clone | 1.0.20 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/dyn-clone/1.0.20/download) |
| cargo | embed_plist | 1.2.2 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/embed_plist/1.2.2/download) |
| cargo | embed-resource | 3.0.12 | MIT | [Source](https://crates.io/api/v1/crates/embed-resource/3.0.12/download) |
| cargo | endi | 1.1.1 | MIT | [Source](https://crates.io/api/v1/crates/endi/1.1.1/download) |
| cargo | enumflags2_derive | 0.7.12 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/enumflags2_derive/0.7.12/download) |
| cargo | enumflags2 | 0.7.12 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/enumflags2/0.7.12/download) |
| cargo | equivalent | 1.0.3 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/equivalent/1.0.3/download) |
| cargo | erased-serde | 0.4.11 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/erased-serde/0.4.11/download) |
| cargo | errno | 0.3.15 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/errno/0.3.15/download) |
| cargo | event-listener-strategy | 0.5.4 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/event-listener-strategy/0.5.4/download) |
| cargo | event-listener | 5.4.2 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/event-listener/5.4.2/download) |
| cargo | fastrand | 2.5.0 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/fastrand/2.5.0/download) |
| cargo | fdeflate | 0.3.7 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/fdeflate/0.3.7/download) |
| cargo | field-offset | 0.3.6 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/field-offset/0.3.6/download) |
| cargo | filedescriptor | 0.8.3 | MIT | [Source](https://crates.io/api/v1/crates/filedescriptor/0.8.3/download) |
| cargo | filetime | 0.2.29 | MIT/Apache-2.0 | [Source](https://crates.io/api/v1/crates/filetime/0.2.29/download) |
| cargo | find-msvc-tools | 0.1.15 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/find-msvc-tools/0.1.15/download) |
| cargo | flate2 | 1.1.11 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/flate2/1.1.11/download) |
| cargo | fnv | 1.0.7 | Apache-2.0 / MIT | [Source](https://crates.io/api/v1/crates/fnv/1.0.7/download) |
| cargo | foldhash | 0.2.0 | Zlib | [Source](https://crates.io/api/v1/crates/foldhash/0.2.0/download) |
| cargo | foreign-types-macros | 0.2.4 | MIT/Apache-2.0 | [Source](https://crates.io/api/v1/crates/foreign-types-macros/0.2.4/download) |
| cargo | foreign-types-shared | 0.3.1 | MIT/Apache-2.0 | [Source](https://crates.io/api/v1/crates/foreign-types-shared/0.3.1/download) |
| cargo | foreign-types | 0.5.0 | MIT/Apache-2.0 | [Source](https://crates.io/api/v1/crates/foreign-types/0.5.0/download) |
| cargo | form_urlencoded | 1.2.2 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/form_urlencoded/1.2.2/download) |
| cargo | futures-channel | 0.3.34 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/futures-channel/0.3.34/download) |
| cargo | futures-core | 0.3.34 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/futures-core/0.3.34/download) |
| cargo | futures-executor | 0.3.34 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/futures-executor/0.3.34/download) |
| cargo | futures-io | 0.3.34 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/futures-io/0.3.34/download) |
| cargo | futures-lite | 2.6.1 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/futures-lite/2.6.1/download) |
| cargo | futures-macro | 0.3.34 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/futures-macro/0.3.34/download) |
| cargo | futures-sink | 0.3.34 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/futures-sink/0.3.34/download) |
| cargo | futures-task | 0.3.34 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/futures-task/0.3.34/download) |
| cargo | futures-util | 0.3.34 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/futures-util/0.3.34/download) |
| cargo | gdk-pixbuf-sys | 0.18.0 | MIT | [Source](https://crates.io/api/v1/crates/gdk-pixbuf-sys/0.18.0/download) |
| cargo | gdk-pixbuf | 0.18.5 | MIT | [Source](https://crates.io/api/v1/crates/gdk-pixbuf/0.18.5/download) |
| cargo | gdk-sys | 0.18.2 | MIT | [Source](https://crates.io/api/v1/crates/gdk-sys/0.18.2/download) |
| cargo | gdk | 0.18.2 | MIT | [Source](https://crates.io/api/v1/crates/gdk/0.18.2/download) |
| cargo | gdkwayland-sys | 0.18.2 | MIT | [Source](https://crates.io/api/v1/crates/gdkwayland-sys/0.18.2/download) |
| cargo | gdkx11-sys | 0.18.2 | MIT | [Source](https://crates.io/api/v1/crates/gdkx11-sys/0.18.2/download) |
| cargo | gdkx11 | 0.18.2 | MIT | [Source](https://crates.io/api/v1/crates/gdkx11/0.18.2/download) |
| cargo | generic-array | 0.14.7 | MIT | [Source](https://crates.io/api/v1/crates/generic-array/0.14.7/download) |
| cargo | getrandom | 0.2.17 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/getrandom/0.2.17/download) |
| cargo | getrandom | 0.3.4 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/getrandom/0.3.4/download) |
| cargo | getrandom | 0.4.3 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/getrandom/0.4.3/download) |
| cargo | gio-sys | 0.18.1 | MIT | [Source](https://crates.io/api/v1/crates/gio-sys/0.18.1/download) |
| cargo | gio | 0.18.4 | MIT | [Source](https://crates.io/api/v1/crates/gio/0.18.4/download) |
| cargo | glib-macros | 0.18.5 | MIT | [Source](https://crates.io/api/v1/crates/glib-macros/0.18.5/download) |
| cargo | glib-sys | 0.18.1 | MIT | [Source](https://crates.io/api/v1/crates/glib-sys/0.18.1/download) |
| cargo | glib | 0.18.5 | MIT | [Source](https://crates.io/api/v1/crates/glib/0.18.5/download) |
| cargo | glob | 0.3.4 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/glob/0.3.4/download) |
| cargo | gobject-sys | 0.18.0 | MIT | [Source](https://crates.io/api/v1/crates/gobject-sys/0.18.0/download) |
| cargo | gtk-sys | 0.18.2 | MIT | [Source](https://crates.io/api/v1/crates/gtk-sys/0.18.2/download) |
| cargo | gtk | 0.18.2 | MIT | [Source](https://crates.io/api/v1/crates/gtk/0.18.2/download) |
| cargo | gtk3-macros | 0.18.2 | MIT | [Source](https://crates.io/api/v1/crates/gtk3-macros/0.18.2/download) |
| cargo | hashbrown | 0.12.3 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/hashbrown/0.12.3/download) |
| cargo | hashbrown | 0.17.1 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/hashbrown/0.17.1/download) |
| cargo | heck | 0.4.1 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/heck/0.4.1/download) |
| cargo | heck | 0.5.0 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/heck/0.5.0/download) |
| cargo | hermit-abi | 0.5.3 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/hermit-abi/0.5.3/download) |
| cargo | hex | 0.4.3 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/hex/0.4.3/download) |
| cargo | hkdf | 0.13.0 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/hkdf/0.13.0/download) |
| cargo | hmac | 0.13.0 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/hmac/0.13.0/download) |
| cargo | html5ever | 0.39.0 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/html5ever/0.39.0/download) |
| cargo | html5ever | 0.40.1 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/html5ever/0.40.1/download) |
| cargo | http-body-util | 0.1.5 | MIT | [Source](https://crates.io/api/v1/crates/http-body-util/0.1.5/download) |
| cargo | http-body | 1.1.0 | MIT | [Source](https://crates.io/api/v1/crates/http-body/1.1.0/download) |
| cargo | http | 1.5.0 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/http/1.5.0/download) |
| cargo | httparse | 1.10.1 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/httparse/1.10.1/download) |
| cargo | hybrid-array | 0.4.15 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/hybrid-array/0.4.15/download) |
| cargo | hyper-rustls | 0.27.10 | Apache-2.0 OR ISC OR MIT | [Source](https://crates.io/api/v1/crates/hyper-rustls/0.27.10/download) |
| cargo | hyper-util | 0.1.21 | MIT | [Source](https://crates.io/api/v1/crates/hyper-util/0.1.21/download) |
| cargo | hyper | 1.12.0 | MIT | [Source](https://crates.io/api/v1/crates/hyper/1.12.0/download) |
| cargo | iana-time-zone-haiku | 0.1.2 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/iana-time-zone-haiku/0.1.2/download) |
| cargo | iana-time-zone | 0.1.65 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/iana-time-zone/0.1.65/download) |
| cargo | ico | 0.6.0 | MIT | [Source](https://crates.io/api/v1/crates/ico/0.6.0/download) |
| cargo | icu_collections | 2.4.0 | Unicode-3.0 | [Source](https://crates.io/api/v1/crates/icu_collections/2.4.0/download) |
| cargo | icu_locale_core | 2.4.0 | Unicode-3.0 | [Source](https://crates.io/api/v1/crates/icu_locale_core/2.4.0/download) |
| cargo | icu_normalizer_data | 2.4.0 | Unicode-3.0 | [Source](https://crates.io/api/v1/crates/icu_normalizer_data/2.4.0/download) |
| cargo | icu_normalizer | 2.4.0 | Unicode-3.0 | [Source](https://crates.io/api/v1/crates/icu_normalizer/2.4.0/download) |
| cargo | icu_properties_data | 2.4.0 | Unicode-3.0 | [Source](https://crates.io/api/v1/crates/icu_properties_data/2.4.0/download) |
| cargo | icu_properties | 2.4.0 | Unicode-3.0 | [Source](https://crates.io/api/v1/crates/icu_properties/2.4.0/download) |
| cargo | icu_provider | 2.4.0 | Unicode-3.0 | [Source](https://crates.io/api/v1/crates/icu_provider/2.4.0/download) |
| cargo | ident_case | 1.0.1 | MIT/Apache-2.0 | [Source](https://crates.io/api/v1/crates/ident_case/1.0.1/download) |
| cargo | idna_adapter | 1.2.2 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/idna_adapter/1.2.2/download) |
| cargo | idna | 1.1.0 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/idna/1.1.0/download) |
| cargo | image | 0.25.10 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/image/0.25.10/download) |
| cargo | indexmap | 1.9.3 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/indexmap/1.9.3/download) |
| cargo | indexmap | 2.14.2 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/indexmap/2.14.2/download) |
| cargo | infer | 0.22.0 | MIT | [Source](https://crates.io/api/v1/crates/infer/0.22.0/download) |
| cargo | inout | 0.2.6 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/inout/0.2.6/download) |
| cargo | ipnet | 2.12.2 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/ipnet/2.12.2/download) |
| cargo | itoa | 1.0.19 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/itoa/1.0.19/download) |
| cargo | javascriptcore-rs-sys | 1.1.1 | MIT | [Source](https://crates.io/api/v1/crates/javascriptcore-rs-sys/1.1.1/download) |
| cargo | javascriptcore-rs | 1.1.2 | MIT | [Source](https://crates.io/api/v1/crates/javascriptcore-rs/1.1.2/download) |
| cargo | jiff-core | 0.1.5 | Unlicense OR MIT | [Source](https://crates.io/api/v1/crates/jiff-core/0.1.5/download) |
| cargo | jiff-static | 0.2.43 | Unlicense OR MIT | [Source](https://crates.io/api/v1/crates/jiff-static/0.2.43/download) |
| cargo | jiff-tzdb-platform | 0.1.3 | Unlicense OR MIT | [Source](https://crates.io/api/v1/crates/jiff-tzdb-platform/0.1.3/download) |
| cargo | jiff-tzdb | 0.1.9 | Unlicense OR MIT | [Source](https://crates.io/api/v1/crates/jiff-tzdb/0.1.9/download) |
| cargo | jiff | 0.2.43 | Unlicense OR MIT | [Source](https://crates.io/api/v1/crates/jiff/0.2.43/download) |
| cargo | jni-macros | 0.22.4 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/jni-macros/0.22.4/download) |
| cargo | jni-sys-macros | 0.4.1 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/jni-sys-macros/0.4.1/download) |
| cargo | jni-sys | 0.3.1 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/jni-sys/0.3.1/download) |
| cargo | jni-sys | 0.4.1 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/jni-sys/0.4.1/download) |
| cargo | jni | 0.21.1 | MIT/Apache-2.0 | [Source](https://crates.io/api/v1/crates/jni/0.21.1/download) |
| cargo | jni | 0.22.4 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/jni/0.22.4/download) |
| cargo | js-sys | 0.3.107 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/js-sys/0.3.107/download) |
| cargo | json-patch | 4.2.0 | MIT/Apache-2.0 | [Source](https://crates.io/api/v1/crates/json-patch/4.2.0/download) |
| cargo | jsonptr | 0.7.1 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/jsonptr/0.7.1/download) |
| cargo | keyboard-types | 0.8.3 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/keyboard-types/0.8.3/download) |
| cargo | keyring-core | 1.0.1 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/keyring-core/1.0.1/download) |
| cargo | keyring | 4.2.0 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/keyring/4.2.0/download) |
| cargo | lazy_static | 1.5.1 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/lazy_static/1.5.1/download) |
| cargo | libappindicator-sys | 0.9.0 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/libappindicator-sys/0.9.0/download) |
| cargo | libappindicator | 0.9.0 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/libappindicator/0.9.0/download) |
| cargo | libc | 0.2.191 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/libc/0.2.191/download) |
| cargo | libdbus-sys | 0.2.7 | Apache-2.0/MIT | [Source](https://crates.io/api/v1/crates/libdbus-sys/0.2.7/download) |
| cargo | libloading | 0.7.4 | ISC | [Source](https://crates.io/api/v1/crates/libloading/0.7.4/download) |
| cargo | libloading | 0.8.9 | ISC | [Source](https://crates.io/api/v1/crates/libloading/0.8.9/download) |
| cargo | libredox | 0.1.25 | MIT | [Source](https://crates.io/api/v1/crates/libredox/0.1.25/download) |
| cargo | link-section | 0.19.4 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/link-section/0.19.4/download) |
| cargo | linux-raw-sys | 0.12.1 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/linux-raw-sys/0.12.1/download) |
| cargo | litemap | 0.8.3 | Unicode-3.0 | [Source](https://crates.io/api/v1/crates/litemap/0.8.3/download) |
| cargo | lock_api | 0.4.14 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/lock_api/0.4.14/download) |
| cargo | log | 0.4.35 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/log/0.4.35/download) |
| cargo | markup5ever | 0.39.0 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/markup5ever/0.39.0/download) |
| cargo | markup5ever | 0.40.0 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/markup5ever/0.40.0/download) |
| cargo | memchr | 2.8.3 | Unlicense OR MIT | [Source](https://crates.io/api/v1/crates/memchr/2.8.3/download) |
| cargo | memoffset | 0.9.1 | MIT | [Source](https://crates.io/api/v1/crates/memoffset/0.9.1/download) |
| cargo | mime | 0.3.18 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/mime/0.3.18/download) |
| cargo | minisign-verify | 0.3.0 | MIT | [Source](https://crates.io/api/v1/crates/minisign-verify/0.3.0/download) |
| cargo | miniz_oxide | 0.8.9 | MIT OR Zlib OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/miniz_oxide/0.8.9/download) |
| cargo | miniz_oxide | 0.9.1 | MIT OR Zlib OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/miniz_oxide/0.9.1/download) |
| cargo | mio | 1.2.5 | MIT | [Source](https://crates.io/api/v1/crates/mio/1.2.5/download) |
| cargo | moxcms | 0.8.1 | BSD-3-Clause OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/moxcms/0.8.1/download) |
| cargo | muda | 0.20.0 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/muda/0.20.0/download) |
| cargo | ndk-context | 0.1.1 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/ndk-context/0.1.1/download) |
| cargo | ndk-sys | 0.6.0+11769913 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/ndk-sys/0.6.0+11769913/download) |
| cargo | ndk | 0.9.0 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/ndk/0.9.0/download) |
| cargo | new_debug_unreachable | 1.0.6 | MIT | [Source](https://crates.io/api/v1/crates/new_debug_unreachable/1.0.6/download) |
| cargo | nix | 0.28.0 | MIT | [Source](https://crates.io/api/v1/crates/nix/0.28.0/download) |
| cargo | nix | 0.32.0 | MIT | [Source](https://crates.io/api/v1/crates/nix/0.32.0/download) |
| cargo | num_enum_derive | 0.7.6 | BSD-3-Clause OR MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/num_enum_derive/0.7.6/download) |
| cargo | num_enum | 0.7.6 | BSD-3-Clause OR MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/num_enum/0.7.6/download) |
| cargo | num-bigint | 0.4.8 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/num-bigint/0.4.8/download) |
| cargo | num-complex | 0.4.6 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/num-complex/0.4.6/download) |
| cargo | num-conv | 0.2.2 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/num-conv/0.2.2/download) |
| cargo | num-integer | 0.1.47 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/num-integer/0.1.47/download) |
| cargo | num-iter | 0.1.46 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/num-iter/0.1.46/download) |
| cargo | num-rational | 0.4.2 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/num-rational/0.4.2/download) |
| cargo | num-traits | 0.2.19 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/num-traits/0.2.19/download) |
| cargo | num | 0.4.3 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/num/0.4.3/download) |
| cargo | objc2-app-kit | 0.3.2 | Zlib OR Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/objc2-app-kit/0.3.2/download) |
| cargo | objc2-cloud-kit | 0.3.2 | Zlib OR Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/objc2-cloud-kit/0.3.2/download) |
| cargo | objc2-core-data | 0.3.2 | Zlib OR Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/objc2-core-data/0.3.2/download) |
| cargo | objc2-core-foundation | 0.3.2 | Zlib OR Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/objc2-core-foundation/0.3.2/download) |
| cargo | objc2-core-graphics | 0.3.2 | Zlib OR Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/objc2-core-graphics/0.3.2/download) |
| cargo | objc2-core-image | 0.3.2 | Zlib OR Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/objc2-core-image/0.3.2/download) |
| cargo | objc2-core-location | 0.3.2 | Zlib OR Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/objc2-core-location/0.3.2/download) |
| cargo | objc2-core-text | 0.3.2 | Zlib OR Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/objc2-core-text/0.3.2/download) |
| cargo | objc2-encode | 4.1.0 | MIT | [Source](https://crates.io/api/v1/crates/objc2-encode/4.1.0/download) |
| cargo | objc2-exception-helper | 0.1.1 | Zlib OR Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/objc2-exception-helper/0.1.1/download) |
| cargo | objc2-foundation | 0.3.2 | MIT | [Source](https://crates.io/api/v1/crates/objc2-foundation/0.3.2/download) |
| cargo | objc2-io-surface | 0.3.2 | Zlib OR Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/objc2-io-surface/0.3.2/download) |
| cargo | objc2-osa-kit | 0.3.2 | Zlib OR Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/objc2-osa-kit/0.3.2/download) |
| cargo | objc2-quartz-core | 0.3.2 | Zlib OR Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/objc2-quartz-core/0.3.2/download) |
| cargo | objc2-ui-kit | 0.3.2 | Zlib OR Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/objc2-ui-kit/0.3.2/download) |
| cargo | objc2-uniform-type-identifiers | 0.3.2 | Zlib OR Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/objc2-uniform-type-identifiers/0.3.2/download) |
| cargo | objc2-user-notifications | 0.3.2 | Zlib OR Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/objc2-user-notifications/0.3.2/download) |
| cargo | objc2-web-kit | 0.3.2 | Zlib OR Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/objc2-web-kit/0.3.2/download) |
| cargo | objc2 | 0.6.5 | MIT | [Source](https://crates.io/api/v1/crates/objc2/0.6.5/download) |
| cargo | once_cell | 1.21.4 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/once_cell/1.21.4/download) |
| cargo | openssl-probe | 0.2.2 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/openssl-probe/0.2.2/download) |
| cargo | option-ext | 0.2.0 | MPL-2.0 | [Source](https://crates.io/api/v1/crates/option-ext/0.2.0/download) |
| cargo | ordered-stream | 0.2.0 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/ordered-stream/0.2.0/download) |
| cargo | osakit | 0.3.1 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/osakit/0.3.1/download) |
| cargo | pango-sys | 0.18.0 | MIT | [Source](https://crates.io/api/v1/crates/pango-sys/0.18.0/download) |
| cargo | pango | 0.18.3 | MIT | [Source](https://crates.io/api/v1/crates/pango/0.18.3/download) |
| cargo | parking_lot_core | 0.9.12 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/parking_lot_core/0.9.12/download) |
| cargo | parking_lot | 0.12.5 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/parking_lot/0.12.5/download) |
| cargo | parking | 2.2.1 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/parking/2.2.1/download) |
| cargo | percent-encoding | 2.3.2 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/percent-encoding/2.3.2/download) |
| cargo | phf_codegen | 0.13.1 | MIT | [Source](https://crates.io/api/v1/crates/phf_codegen/0.13.1/download) |
| cargo | phf_codegen | 0.14.0 | MIT | [Source](https://crates.io/api/v1/crates/phf_codegen/0.14.0/download) |
| cargo | phf_generator | 0.13.1 | MIT | [Source](https://crates.io/api/v1/crates/phf_generator/0.13.1/download) |
| cargo | phf_generator | 0.14.0 | MIT | [Source](https://crates.io/api/v1/crates/phf_generator/0.14.0/download) |
| cargo | phf_macros | 0.13.1 | MIT | [Source](https://crates.io/api/v1/crates/phf_macros/0.13.1/download) |
| cargo | phf_macros | 0.14.0 | MIT | [Source](https://crates.io/api/v1/crates/phf_macros/0.14.0/download) |
| cargo | phf_shared | 0.13.1 | MIT | [Source](https://crates.io/api/v1/crates/phf_shared/0.13.1/download) |
| cargo | phf_shared | 0.14.0 | MIT | [Source](https://crates.io/api/v1/crates/phf_shared/0.14.0/download) |
| cargo | phf | 0.13.1 | MIT | [Source](https://crates.io/api/v1/crates/phf/0.13.1/download) |
| cargo | phf | 0.14.0 | MIT | [Source](https://crates.io/api/v1/crates/phf/0.14.0/download) |
| cargo | pin-project-lite | 0.2.17 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/pin-project-lite/0.2.17/download) |
| cargo | piper | 0.2.5 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/piper/0.2.5/download) |
| cargo | pkg-config | 0.3.34 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/pkg-config/0.3.34/download) |
| cargo | plist | 1.10.3 | MIT | [Source](https://crates.io/api/v1/crates/plist/1.10.3/download) |
| cargo | png | 0.18.1 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/png/0.18.1/download) |
| cargo | polling | 3.11.0 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/polling/3.11.0/download) |
| cargo | pollster | 1.0.1 | Apache-2.0/MIT | [Source](https://crates.io/api/v1/crates/pollster/1.0.1/download) |
| cargo | portable-atomic-util | 0.2.8 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/portable-atomic-util/0.2.8/download) |
| cargo | portable-atomic | 1.15.0 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/portable-atomic/1.15.0/download) |
| cargo | portable-pty | 0.9.0 | MIT | [Source](https://crates.io/api/v1/crates/portable-pty/0.9.0/download) |
| cargo | potential_utf | 0.1.6 | Unicode-3.0 | [Source](https://crates.io/api/v1/crates/potential_utf/0.1.6/download) |
| cargo | powerfmt | 0.2.1 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/powerfmt/0.2.1/download) |
| cargo | precomputed-hash | 0.1.1 | MIT | [Source](https://crates.io/api/v1/crates/precomputed-hash/0.1.1/download) |
| cargo | proc-macro-crate | 1.3.1 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/proc-macro-crate/1.3.1/download) |
| cargo | proc-macro-crate | 2.0.2 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/proc-macro-crate/2.0.2/download) |
| cargo | proc-macro-crate | 3.5.0 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/proc-macro-crate/3.5.0/download) |
| cargo | proc-macro-error-attr | 1.0.4 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/proc-macro-error-attr/1.0.4/download) |
| cargo | proc-macro-error | 1.0.4 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/proc-macro-error/1.0.4/download) |
| cargo | proc-macro2 | 1.0.107 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/proc-macro2/1.0.107/download) |
| cargo | pxfm | 0.1.30 | BSD-3-Clause OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/pxfm/0.1.30/download) |
| cargo | quick-xml | 0.41.0 | MIT | [Source](https://crates.io/api/v1/crates/quick-xml/0.41.0/download) |
| cargo | quick-xml | 0.42.0 | MIT | [Source](https://crates.io/api/v1/crates/quick-xml/0.42.0/download) |
| cargo | quote | 1.0.47 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/quote/1.0.47/download) |
| cargo | r-efi | 5.3.0 | MIT OR Apache-2.0 OR LGPL-2.1-or-later | [Source](https://crates.io/api/v1/crates/r-efi/5.3.0/download) |
| cargo | r-efi | 6.0.0 | MIT OR Apache-2.0 OR LGPL-2.1-or-later | [Source](https://crates.io/api/v1/crates/r-efi/6.0.0/download) |
| cargo | raw-window-handle | 0.6.2 | MIT OR Apache-2.0 OR Zlib | [Source](https://crates.io/api/v1/crates/raw-window-handle/0.6.2/download) |
| cargo | redox_syscall | 0.5.18 | MIT | [Source](https://crates.io/api/v1/crates/redox_syscall/0.5.18/download) |
| cargo | redox_users | 0.5.3 | MIT | [Source](https://crates.io/api/v1/crates/redox_users/0.5.3/download) |
| cargo | ref-cast-impl | 1.0.27 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/ref-cast-impl/1.0.27/download) |
| cargo | ref-cast | 1.0.27 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/ref-cast/1.0.27/download) |
| cargo | regex-automata | 0.4.18 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/regex-automata/0.4.18/download) |
| cargo | regex-syntax | 0.8.11 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/regex-syntax/0.8.11/download) |
| cargo | regex | 1.13.1 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/regex/1.13.1/download) |
| cargo | reqwest | 0.13.5 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/reqwest/0.13.5/download) |
| cargo | rfd | 0.18.0 | MIT | [Source](https://crates.io/api/v1/crates/rfd/0.18.0/download) |
| cargo | ring | 0.17.14 | Apache-2.0 AND ISC | [Source](https://crates.io/api/v1/crates/ring/0.17.14/download) |
| cargo | rustc_version | 0.4.1 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/rustc_version/0.4.1/download) |
| cargo | rustc-hash | 2.1.3 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/rustc-hash/2.1.3/download) |
| cargo | rustix | 1.1.6 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/rustix/1.1.6/download) |
| cargo | rustls-native-certs | 0.8.5 | Apache-2.0 OR ISC OR MIT | [Source](https://crates.io/api/v1/crates/rustls-native-certs/0.8.5/download) |
| cargo | rustls-pki-types | 1.16.0 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/rustls-pki-types/1.16.0/download) |
| cargo | rustls-platform-verifier-android | 0.2.0 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/rustls-platform-verifier-android/0.2.0/download) |
| cargo | rustls-platform-verifier | 0.7.1 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/rustls-platform-verifier/0.7.1/download) |
| cargo | rustls-webpki | 0.103.17 | ISC | [Source](https://crates.io/api/v1/crates/rustls-webpki/0.103.17/download) |
| cargo | rustls | 0.23.46 | Apache-2.0 OR ISC OR MIT | [Source](https://crates.io/api/v1/crates/rustls/0.23.46/download) |
| cargo | rustversion | 1.0.23 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/rustversion/1.0.23/download) |
| cargo | same-file | 1.0.6 | Unlicense/MIT | [Source](https://crates.io/api/v1/crates/same-file/1.0.6/download) |
| cargo | schannel | 0.1.30 | MIT | [Source](https://crates.io/api/v1/crates/schannel/0.1.30/download) |
| cargo | schemars_derive | 0.8.22 | MIT | [Source](https://crates.io/api/v1/crates/schemars_derive/0.8.22/download) |
| cargo | schemars | 0.8.22 | MIT | [Source](https://crates.io/api/v1/crates/schemars/0.8.22/download) |
| cargo | schemars | 0.9.0 | MIT | [Source](https://crates.io/api/v1/crates/schemars/0.9.0/download) |
| cargo | schemars | 1.2.3 | MIT | [Source](https://crates.io/api/v1/crates/schemars/1.2.3/download) |
| cargo | scoped-tls | 1.0.1 | MIT/Apache-2.0 | [Source](https://crates.io/api/v1/crates/scoped-tls/1.0.1/download) |
| cargo | scopeguard | 1.2.0 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/scopeguard/1.2.0/download) |
| cargo | secret-service | 5.2.0 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/secret-service/5.2.0/download) |
| cargo | security-framework-sys | 2.17.0 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/security-framework-sys/2.17.0/download) |
| cargo | security-framework | 3.7.0 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/security-framework/3.7.0/download) |
| cargo | selectors | 0.38.0 | MPL-2.0 | [Source](https://crates.io/api/v1/crates/selectors/0.38.0/download) |
| cargo | selectors | 0.41.0 | MPL-2.0 | [Source](https://crates.io/api/v1/crates/selectors/0.41.0/download) |
| cargo | semver | 1.0.28 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/semver/1.0.28/download) |
| cargo | serde_core | 1.0.229 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/serde_core/1.0.229/download) |
| cargo | serde_derive_internals | 0.29.1 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/serde_derive_internals/0.29.1/download) |
| cargo | serde_derive | 1.0.229 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/serde_derive/1.0.229/download) |
| cargo | serde_json | 1.0.154 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/serde_json/1.0.154/download) |
| cargo | serde_repr | 0.1.21 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/serde_repr/0.1.21/download) |
| cargo | serde_spanned | 0.6.9 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/serde_spanned/0.6.9/download) |
| cargo | serde_spanned | 1.1.3 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/serde_spanned/1.1.3/download) |
| cargo | serde_with_macros | 3.24.0 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/serde_with_macros/3.24.0/download) |
| cargo | serde_with | 3.24.0 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/serde_with/3.24.0/download) |
| cargo | serde-untagged | 0.1.9 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/serde-untagged/0.1.9/download) |
| cargo | serde | 1.0.229 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/serde/1.0.229/download) |
| cargo | serial2 | 0.2.39 | BSD-2-Clause OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/serial2/0.2.39/download) |
| cargo | serialize-to-javascript-impl | 0.1.2 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/serialize-to-javascript-impl/0.1.2/download) |
| cargo | serialize-to-javascript | 0.1.2 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/serialize-to-javascript/0.1.2/download) |
| cargo | servo_arc | 0.4.3 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/servo_arc/0.4.3/download) |
| cargo | servo_arc | 0.5.0 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/servo_arc/0.5.0/download) |
| cargo | sha2 | 0.10.9 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/sha2/0.10.9/download) |
| cargo | sha2 | 0.11.1 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/sha2/0.11.1/download) |
| cargo | shared_library | 0.1.9 | Apache-2.0/MIT | [Source](https://crates.io/api/v1/crates/shared_library/0.1.9/download) |
| cargo | shell-words | 1.1.1 | MIT/Apache-2.0 | [Source](https://crates.io/api/v1/crates/shell-words/1.1.1/download) |
| cargo | shlex | 2.0.1 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/shlex/2.0.1/download) |
| cargo | signal-hook-registry | 1.4.8 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/signal-hook-registry/1.4.8/download) |
| cargo | simd_cesu8 | 1.2.0 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/simd_cesu8/1.2.0/download) |
| cargo | simd-adler32 | 0.3.10 | MIT | [Source](https://crates.io/api/v1/crates/simd-adler32/0.3.10/download) |
| cargo | simdutf8 | 0.1.5 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/simdutf8/0.1.5/download) |
| cargo | siphasher | 1.0.4 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/siphasher/1.0.4/download) |
| cargo | slab | 0.4.12 | MIT | [Source](https://crates.io/api/v1/crates/slab/0.4.12/download) |
| cargo | smallvec | 1.16.5 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/smallvec/1.16.5/download) |
| cargo | socket2 | 0.6.5 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/socket2/0.6.5/download) |
| cargo | softbuffer | 0.4.8 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/softbuffer/0.4.8/download) |
| cargo | soup3-sys | 0.5.0 | MIT | [Source](https://crates.io/api/v1/crates/soup3-sys/0.5.0/download) |
| cargo | soup3 | 0.5.0 | MIT | [Source](https://crates.io/api/v1/crates/soup3/0.5.0/download) |
| cargo | stable_deref_trait | 1.2.1 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/stable_deref_trait/1.2.1/download) |
| cargo | static_vcruntime | 3.0.0 | MIT OR Apache-2.0 OR Zlib | [Source](https://crates.io/api/v1/crates/static_vcruntime/3.0.0/download) |
| cargo | string_cache_codegen | 0.11.2 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/string_cache_codegen/0.11.2/download) |
| cargo | string_cache_codegen | 0.6.1 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/string_cache_codegen/0.6.1/download) |
| cargo | string_cache | 0.11.0 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/string_cache/0.11.0/download) |
| cargo | string_cache | 0.9.0 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/string_cache/0.9.0/download) |
| cargo | strsim | 0.11.1 | MIT | [Source](https://crates.io/api/v1/crates/strsim/0.11.1/download) |
| cargo | subtle | 2.6.1 | BSD-3-Clause | [Source](https://crates.io/api/v1/crates/subtle/2.6.1/download) |
| cargo | swift-rs | 1.0.9 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/swift-rs/1.0.9/download) |
| cargo | syn | 1.0.109 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/syn/1.0.109/download) |
| cargo | syn | 2.0.119 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/syn/2.0.119/download) |
| cargo | syn | 3.0.10 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/syn/3.0.10/download) |
| cargo | sync_wrapper | 1.0.2 | Apache-2.0 | [Source](https://crates.io/api/v1/crates/sync_wrapper/1.0.2/download) |
| cargo | synstructure | 0.14.0 | MIT | [Source](https://crates.io/api/v1/crates/synstructure/0.14.0/download) |
| cargo | system-configuration-sys | 0.6.0 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/system-configuration-sys/0.6.0/download) |
| cargo | system-configuration | 0.7.0 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/system-configuration/0.7.0/download) |
| cargo | system-deps | 6.2.2 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/system-deps/6.2.2/download) |
| cargo | tao-macros | 0.1.4 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/tao-macros/0.1.4/download) |
| cargo | tao | 0.37.2 | Apache-2.0 | [Source](https://crates.io/api/v1/crates/tao/0.37.2/download) |
| cargo | tar | 0.4.46 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/tar/0.4.46/download) |
| cargo | target-lexicon | 0.12.16 | Apache-2.0 WITH LLVM-exception | [Source](https://crates.io/api/v1/crates/target-lexicon/0.12.16/download) |
| cargo | tauri-build | 2.7.4 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/tauri-build/2.7.4/download) |
| cargo | tauri-codegen | 2.7.4 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/tauri-codegen/2.7.4/download) |
| cargo | tauri-macros | 2.7.4 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/tauri-macros/2.7.4/download) |
| cargo | tauri-plugin-updater | 2.14.1 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/tauri-plugin-updater/2.14.1/download) |
| cargo | tauri-plugin | 2.7.2 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/tauri-plugin/2.7.2/download) |
| cargo | tauri-runtime-wry | 2.12.3 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/tauri-runtime-wry/2.12.3/download) |
| cargo | tauri-runtime | 2.12.2 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/tauri-runtime/2.12.2/download) |
| cargo | tauri-utils | 2.10.2 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/tauri-utils/2.10.2/download) |
| cargo | tauri-winres | 0.3.7 | MIT | [Source](https://crates.io/api/v1/crates/tauri-winres/0.3.7/download) |
| cargo | tauri | 2.12.5 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/tauri/2.12.5/download) |
| cargo | tempfile | 3.27.0 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/tempfile/3.27.0/download) |
| cargo | tendril | 0.5.1 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/tendril/0.5.1/download) |
| cargo | thiserror-impl | 1.0.69 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/thiserror-impl/1.0.69/download) |
| cargo | thiserror-impl | 2.0.21 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/thiserror-impl/2.0.21/download) |
| cargo | thiserror | 1.0.69 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/thiserror/1.0.69/download) |
| cargo | thiserror | 2.0.21 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/thiserror/2.0.21/download) |
| cargo | time-core | 0.1.9 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/time-core/0.1.9/download) |
| cargo | time-macros | 0.2.32 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/time-macros/0.2.32/download) |
| cargo | time | 0.3.55 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/time/0.3.55/download) |
| cargo | tinystr | 0.8.5 | Unicode-3.0 | [Source](https://crates.io/api/v1/crates/tinystr/0.8.5/download) |
| cargo | tinyvec | 1.13.3 | Zlib OR Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/tinyvec/1.13.3/download) |
| cargo | tokio-rustls | 0.26.6 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/tokio-rustls/0.26.6/download) |
| cargo | tokio-util | 0.7.20 | MIT | [Source](https://crates.io/api/v1/crates/tokio-util/0.7.20/download) |
| cargo | tokio | 1.54.1 | MIT | [Source](https://crates.io/api/v1/crates/tokio/1.54.1/download) |
| cargo | toml_datetime | 0.6.3 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/toml_datetime/0.6.3/download) |
| cargo | toml_datetime | 1.1.3+spec-1.1.0 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/toml_datetime/1.1.3+spec-1.1.0/download) |
| cargo | toml_edit | 0.19.15 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/toml_edit/0.19.15/download) |
| cargo | toml_edit | 0.20.2 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/toml_edit/0.20.2/download) |
| cargo | toml_edit | 0.25.19+spec-1.1.0 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/toml_edit/0.25.19+spec-1.1.0/download) |
| cargo | toml_parser | 1.1.5+spec-1.1.0 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/toml_parser/1.1.5+spec-1.1.0/download) |
| cargo | toml_writer | 1.2.0+spec-1.1.0 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/toml_writer/1.2.0+spec-1.1.0/download) |
| cargo | toml | 0.8.2 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/toml/0.8.2/download) |
| cargo | toml | 1.2.1+spec-1.1.0 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/toml/1.2.1+spec-1.1.0/download) |
| cargo | tower-http | 0.6.11 | MIT | [Source](https://crates.io/api/v1/crates/tower-http/0.6.11/download) |
| cargo | tower-layer | 0.3.3 | MIT | [Source](https://crates.io/api/v1/crates/tower-layer/0.3.3/download) |
| cargo | tower-service | 0.3.3 | MIT | [Source](https://crates.io/api/v1/crates/tower-service/0.3.3/download) |
| cargo | tower | 0.5.3 | MIT | [Source](https://crates.io/api/v1/crates/tower/0.5.3/download) |
| cargo | tracing-attributes | 0.1.31 | MIT | [Source](https://crates.io/api/v1/crates/tracing-attributes/0.1.31/download) |
| cargo | tracing-core | 0.1.36 | MIT | [Source](https://crates.io/api/v1/crates/tracing-core/0.1.36/download) |
| cargo | tracing | 0.1.44 | MIT | [Source](https://crates.io/api/v1/crates/tracing/0.1.44/download) |
| cargo | tray-icon | 0.25.1 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/tray-icon/0.25.1/download) |
| cargo | try-lock | 0.2.5 | MIT | [Source](https://crates.io/api/v1/crates/try-lock/0.2.5/download) |
| cargo | typed-path | 0.13.0 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/typed-path/0.13.0/download) |
| cargo | typeid | 1.0.3 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/typeid/1.0.3/download) |
| cargo | typenum | 1.20.1 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/typenum/1.20.1/download) |
| cargo | uds_windows | 1.2.1 | MIT | [Source](https://crates.io/api/v1/crates/uds_windows/1.2.1/download) |
| cargo | unicode-ident | 1.0.27 | (MIT OR Apache-2.0) AND Unicode-3.0 | [Source](https://crates.io/api/v1/crates/unicode-ident/1.0.27/download) |
| cargo | unicode-segmentation | 1.13.3 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/unicode-segmentation/1.13.3/download) |
| cargo | untrusted | 0.9.0 | ISC | [Source](https://crates.io/api/v1/crates/untrusted/0.9.0/download) |
| cargo | url | 2.5.8 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/url/2.5.8/download) |
| cargo | urlpattern | 0.6.0 | MIT | [Source](https://crates.io/api/v1/crates/urlpattern/0.6.0/download) |
| cargo | utf_types | 1.0.0 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/utf_types/1.0.0/download) |
| cargo | utf8_iter | 1.1.0 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/utf8_iter/1.1.0/download) |
| cargo | uuid | 1.29.2 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/uuid/1.29.2/download) |
| cargo | version_check | 0.9.5 | MIT/Apache-2.0 | [Source](https://crates.io/api/v1/crates/version_check/0.9.5/download) |
| cargo | version-compare | 0.2.1 | MIT | [Source](https://crates.io/api/v1/crates/version-compare/0.2.1/download) |
| cargo | vswhom-sys | 0.1.3 | MIT | [Source](https://crates.io/api/v1/crates/vswhom-sys/0.1.3/download) |
| cargo | vswhom | 0.1.0 | MIT | [Source](https://crates.io/api/v1/crates/vswhom/0.1.0/download) |
| cargo | walkdir | 2.5.0 | Unlicense/MIT | [Source](https://crates.io/api/v1/crates/walkdir/2.5.0/download) |
| cargo | want | 0.3.2 | MIT | [Source](https://crates.io/api/v1/crates/want/0.3.2/download) |
| cargo | wasi | 0.11.1+wasi-snapshot-preview1 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/wasi/0.11.1+wasi-snapshot-preview1/download) |
| cargo | wasip2 | 1.0.4+wasi-0.2.12 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/wasip2/1.0.4+wasi-0.2.12/download) |
| cargo | wasm-bindgen-futures | 0.4.80 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/wasm-bindgen-futures/0.4.80/download) |
| cargo | wasm-bindgen-macro-support | 0.2.130 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/wasm-bindgen-macro-support/0.2.130/download) |
| cargo | wasm-bindgen-macro | 0.2.130 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/wasm-bindgen-macro/0.2.130/download) |
| cargo | wasm-bindgen-shared | 0.2.130 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/wasm-bindgen-shared/0.2.130/download) |
| cargo | wasm-bindgen | 0.2.130 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/wasm-bindgen/0.2.130/download) |
| cargo | wasm-streams | 0.5.0 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/wasm-streams/0.5.0/download) |
| cargo | wayland-backend | 0.3.17 | MIT | [Source](https://crates.io/api/v1/crates/wayland-backend/0.3.17/download) |
| cargo | wayland-client | 0.31.15 | MIT | [Source](https://crates.io/api/v1/crates/wayland-client/0.31.15/download) |
| cargo | wayland-protocols | 0.32.13 | MIT | [Source](https://crates.io/api/v1/crates/wayland-protocols/0.32.13/download) |
| cargo | wayland-scanner | 0.31.11 | MIT | [Source](https://crates.io/api/v1/crates/wayland-scanner/0.31.11/download) |
| cargo | wayland-sys | 0.31.11 | MIT | [Source](https://crates.io/api/v1/crates/wayland-sys/0.31.11/download) |
| cargo | web_atoms | 0.2.6 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/web_atoms/0.2.6/download) |
| cargo | web_atoms | 0.3.0 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/web_atoms/0.3.0/download) |
| cargo | web-sys | 0.3.107 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/web-sys/0.3.107/download) |
| cargo | web-time | 1.1.0 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/web-time/1.1.0/download) |
| cargo | webkit2gtk-sys | 2.0.2 | MIT | [Source](https://crates.io/api/v1/crates/webkit2gtk-sys/2.0.2/download) |
| cargo | webkit2gtk | 2.0.2 | MIT | [Source](https://crates.io/api/v1/crates/webkit2gtk/2.0.2/download) |
| cargo | webpki-root-certs | 1.0.12 | CDLA-Permissive-2.0 | [Source](https://crates.io/api/v1/crates/webpki-root-certs/1.0.12/download) |
| cargo | webview2-com-macros | 0.8.1 | MIT | [Source](https://crates.io/api/v1/crates/webview2-com-macros/0.8.1/download) |
| cargo | webview2-com-sys | 0.39.1 | MIT | [Source](https://crates.io/api/v1/crates/webview2-com-sys/0.39.1/download) |
| cargo | webview2-com | 0.39.1 | MIT | [Source](https://crates.io/api/v1/crates/webview2-com/0.39.1/download) |
| cargo | winapi-i686-pc-windows-gnu | 0.4.0 | MIT/Apache-2.0 | [Source](https://crates.io/api/v1/crates/winapi-i686-pc-windows-gnu/0.4.0/download) |
| cargo | winapi-util | 0.1.11 | Unlicense OR MIT | [Source](https://crates.io/api/v1/crates/winapi-util/0.1.11/download) |
| cargo | winapi-x86_64-pc-windows-gnu | 0.4.0 | MIT/Apache-2.0 | [Source](https://crates.io/api/v1/crates/winapi-x86_64-pc-windows-gnu/0.4.0/download) |
| cargo | winapi | 0.3.9 | MIT/Apache-2.0 | [Source](https://crates.io/api/v1/crates/winapi/0.3.9/download) |
| cargo | window-vibrancy | 0.8.1 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/window-vibrancy/0.8.1/download) |
| cargo | windows_aarch64_gnullvm | 0.42.2 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/windows_aarch64_gnullvm/0.42.2/download) |
| cargo | windows_aarch64_gnullvm | 0.52.6 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/windows_aarch64_gnullvm/0.52.6/download) |
| cargo | windows_aarch64_msvc | 0.42.2 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/windows_aarch64_msvc/0.42.2/download) |
| cargo | windows_aarch64_msvc | 0.52.6 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/windows_aarch64_msvc/0.52.6/download) |
| cargo | windows_i686_gnu | 0.42.2 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/windows_i686_gnu/0.42.2/download) |
| cargo | windows_i686_gnu | 0.52.6 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/windows_i686_gnu/0.52.6/download) |
| cargo | windows_i686_gnullvm | 0.52.6 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/windows_i686_gnullvm/0.52.6/download) |
| cargo | windows_i686_msvc | 0.42.2 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/windows_i686_msvc/0.42.2/download) |
| cargo | windows_i686_msvc | 0.52.6 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/windows_i686_msvc/0.52.6/download) |
| cargo | windows_x86_64_gnu | 0.42.2 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/windows_x86_64_gnu/0.42.2/download) |
| cargo | windows_x86_64_gnu | 0.52.6 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/windows_x86_64_gnu/0.52.6/download) |
| cargo | windows_x86_64_gnullvm | 0.42.2 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/windows_x86_64_gnullvm/0.42.2/download) |
| cargo | windows_x86_64_gnullvm | 0.52.6 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/windows_x86_64_gnullvm/0.52.6/download) |
| cargo | windows_x86_64_msvc | 0.42.2 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/windows_x86_64_msvc/0.42.2/download) |
| cargo | windows_x86_64_msvc | 0.52.6 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/windows_x86_64_msvc/0.52.6/download) |
| cargo | windows-collections | 0.3.2 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/windows-collections/0.3.2/download) |
| cargo | windows-core | 0.62.2 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/windows-core/0.62.2/download) |
| cargo | windows-future | 0.3.2 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/windows-future/0.3.2/download) |
| cargo | windows-implement | 0.60.2 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/windows-implement/0.60.2/download) |
| cargo | windows-interface | 0.59.3 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/windows-interface/0.59.3/download) |
| cargo | windows-link | 0.2.1 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/windows-link/0.2.1/download) |
| cargo | windows-native-keyring-store | 1.1.0 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/windows-native-keyring-store/1.1.0/download) |
| cargo | windows-numerics | 0.3.1 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/windows-numerics/0.3.1/download) |
| cargo | windows-registry | 0.6.1 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/windows-registry/0.6.1/download) |
| cargo | windows-result | 0.4.1 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/windows-result/0.4.1/download) |
| cargo | windows-strings | 0.5.1 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/windows-strings/0.5.1/download) |
| cargo | windows-sys | 0.45.0 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/windows-sys/0.45.0/download) |
| cargo | windows-sys | 0.52.0 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/windows-sys/0.52.0/download) |
| cargo | windows-sys | 0.61.2 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/windows-sys/0.61.2/download) |
| cargo | windows-targets | 0.42.2 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/windows-targets/0.42.2/download) |
| cargo | windows-targets | 0.52.6 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/windows-targets/0.52.6/download) |
| cargo | windows-threading | 0.2.1 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/windows-threading/0.2.1/download) |
| cargo | windows-version | 0.1.7 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/windows-version/0.1.7/download) |
| cargo | windows | 0.62.2 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/windows/0.62.2/download) |
| cargo | winnow | 0.5.40 | MIT | [Source](https://crates.io/api/v1/crates/winnow/0.5.40/download) |
| cargo | winnow | 1.0.5 | MIT | [Source](https://crates.io/api/v1/crates/winnow/1.0.5/download) |
| cargo | winreg | 0.10.1 | MIT | [Source](https://crates.io/api/v1/crates/winreg/0.10.1/download) |
| cargo | winreg | 0.56.0 | MIT | [Source](https://crates.io/api/v1/crates/winreg/0.56.0/download) |
| cargo | wit-bindgen | 0.57.1 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/wit-bindgen/0.57.1/download) |
| cargo | writeable | 0.6.4 | Unicode-3.0 | [Source](https://crates.io/api/v1/crates/writeable/0.6.4/download) |
| cargo | wry | 0.57.2 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/wry/0.57.2/download) |
| cargo | x11-dl | 2.21.0 | MIT | [Source](https://crates.io/api/v1/crates/x11-dl/2.21.0/download) |
| cargo | x11 | 2.21.0 | MIT | [Source](https://crates.io/api/v1/crates/x11/2.21.0/download) |
| cargo | xattr | 1.7.0 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/xattr/1.7.0/download) |
| cargo | yoke-derive | 0.8.4 | Unicode-3.0 | [Source](https://crates.io/api/v1/crates/yoke-derive/0.8.4/download) |
| cargo | yoke | 0.8.4 | Unicode-3.0 | [Source](https://crates.io/api/v1/crates/yoke/0.8.4/download) |
| cargo | zbus_macros | 5.19.0 | MIT | [Source](https://crates.io/api/v1/crates/zbus_macros/5.19.0/download) |
| cargo | zbus_names | 4.3.5 | MIT | [Source](https://crates.io/api/v1/crates/zbus_names/4.3.5/download) |
| cargo | zbus-secret-service-keyring-store | 1.0.1 | MIT OR Apache-2.0 | [Source](https://crates.io/api/v1/crates/zbus-secret-service-keyring-store/1.0.1/download) |
| cargo | zbus | 5.19.0 | MIT | [Source](https://crates.io/api/v1/crates/zbus/5.19.0/download) |
| cargo | zcheapstr | 1.2.0 | MIT | [Source](https://crates.io/api/v1/crates/zcheapstr/1.2.0/download) |
| cargo | zerofrom-derive | 0.1.8 | Unicode-3.0 | [Source](https://crates.io/api/v1/crates/zerofrom-derive/0.1.8/download) |
| cargo | zerofrom | 0.1.8 | Unicode-3.0 | [Source](https://crates.io/api/v1/crates/zerofrom/0.1.8/download) |
| cargo | zeroize_derive | 1.5.0 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/zeroize_derive/1.5.0/download) |
| cargo | zeroize | 1.9.1 | Apache-2.0 OR MIT | [Source](https://crates.io/api/v1/crates/zeroize/1.9.1/download) |
| cargo | zerotrie | 0.2.5 | Unicode-3.0 | [Source](https://crates.io/api/v1/crates/zerotrie/0.2.5/download) |
| cargo | zerovec-derive | 0.11.7 | Unicode-3.0 | [Source](https://crates.io/api/v1/crates/zerovec-derive/0.11.7/download) |
| cargo | zerovec | 0.11.9 | Unicode-3.0 | [Source](https://crates.io/api/v1/crates/zerovec/0.11.9/download) |
| cargo | zip | 9.6.0 | MIT | [Source](https://crates.io/api/v1/crates/zip/9.6.0/download) |
| cargo | zlib-rs | 0.6.8 | Zlib | [Source](https://crates.io/api/v1/crates/zlib-rs/0.6.8/download) |
| cargo | zmij | 1.0.23 | MIT | [Source](https://crates.io/api/v1/crates/zmij/1.0.23/download) |
| cargo | zvariant_derive | 5.15.1 | MIT | [Source](https://crates.io/api/v1/crates/zvariant_derive/5.15.1/download) |
| cargo | zvariant_utils | 4.2.0 | MIT | [Source](https://crates.io/api/v1/crates/zvariant_utils/4.2.0/download) |
| cargo | zvariant | 5.15.1 | MIT | [Source](https://crates.io/api/v1/crates/zvariant/5.15.1/download) |
| npm | @aiden0z/pptx-renderer | 1.4.0 | Apache-2.0 | [Source](https://www.npmjs.com/package/@aiden0z/pptx-renderer/v/1.4.0) |
| npm | @floating-ui/core | 1.8.0 | MIT | [Source](https://www.npmjs.com/package/@floating-ui/core/v/1.8.0) |
| npm | @floating-ui/dom | 1.8.0 | MIT | [Source](https://www.npmjs.com/package/@floating-ui/dom/v/1.8.0) |
| npm | @floating-ui/react-dom | 2.1.9 | MIT | [Source](https://www.npmjs.com/package/@floating-ui/react-dom/v/2.1.9) |
| npm | @floating-ui/utils | 0.2.12 | MIT | [Source](https://www.npmjs.com/package/@floating-ui/utils/v/0.2.12) |
| npm | @fontsource-variable/inter | 5.3.0 | OFL-1.1 | [Source](https://www.npmjs.com/package/@fontsource-variable/inter/v/5.3.0) |
| npm | @hono/node-server | 2.1.8 | MIT | [Source](https://www.npmjs.com/package/@hono/node-server/v/2.1.8) |
| npm | @modelcontextprotocol/sdk | 1.32.2 | MIT | [Source](https://www.npmjs.com/package/@modelcontextprotocol/sdk/v/1.32.2) |
| npm | @napi-rs/canvas-android-arm64 | 1.1.1 | MIT | [Source](https://www.npmjs.com/package/@napi-rs/canvas-android-arm64/v/1.1.1) |
| npm | @napi-rs/canvas-darwin-arm64 | 1.1.1 | MIT | [Source](https://www.npmjs.com/package/@napi-rs/canvas-darwin-arm64/v/1.1.1) |
| npm | @napi-rs/canvas-darwin-x64 | 1.1.1 | MIT | [Source](https://www.npmjs.com/package/@napi-rs/canvas-darwin-x64/v/1.1.1) |
| npm | @napi-rs/canvas-linux-arm-gnueabihf | 1.1.1 | MIT | [Source](https://www.npmjs.com/package/@napi-rs/canvas-linux-arm-gnueabihf/v/1.1.1) |
| npm | @napi-rs/canvas-linux-arm64-gnu | 1.1.1 | MIT | [Source](https://www.npmjs.com/package/@napi-rs/canvas-linux-arm64-gnu/v/1.1.1) |
| npm | @napi-rs/canvas-linux-arm64-musl | 1.1.1 | MIT | [Source](https://www.npmjs.com/package/@napi-rs/canvas-linux-arm64-musl/v/1.1.1) |
| npm | @napi-rs/canvas-linux-riscv64-gnu | 1.1.1 | MIT | [Source](https://www.npmjs.com/package/@napi-rs/canvas-linux-riscv64-gnu/v/1.1.1) |
| npm | @napi-rs/canvas-linux-x64-gnu | 1.1.1 | MIT | [Source](https://www.npmjs.com/package/@napi-rs/canvas-linux-x64-gnu/v/1.1.1) |
| npm | @napi-rs/canvas-linux-x64-musl | 1.1.1 | MIT | [Source](https://www.npmjs.com/package/@napi-rs/canvas-linux-x64-musl/v/1.1.1) |
| npm | @napi-rs/canvas-win32-arm64-msvc | 1.1.1 | MIT | [Source](https://www.npmjs.com/package/@napi-rs/canvas-win32-arm64-msvc/v/1.1.1) |
| npm | @napi-rs/canvas-win32-x64-msvc | 1.1.1 | MIT | [Source](https://www.npmjs.com/package/@napi-rs/canvas-win32-x64-msvc/v/1.1.1) |
| npm | @napi-rs/canvas | 1.1.1 | MIT | [Source](https://www.npmjs.com/package/@napi-rs/canvas/v/1.1.1) |
| npm | @radix-ui/number | 1.1.3 | MIT | [Source](https://www.npmjs.com/package/@radix-ui/number/v/1.1.3) |
| npm | @radix-ui/primitive | 1.2.0 | MIT | [Source](https://www.npmjs.com/package/@radix-ui/primitive/v/1.2.0) |
| npm | @radix-ui/react-arrow | 1.1.17 | MIT | [Source](https://www.npmjs.com/package/@radix-ui/react-arrow/v/1.1.17) |
| npm | @radix-ui/react-collection | 1.2.0 | MIT | [Source](https://www.npmjs.com/package/@radix-ui/react-collection/v/1.2.0) |
| npm | @radix-ui/react-compose-refs | 1.1.5 | MIT | [Source](https://www.npmjs.com/package/@radix-ui/react-compose-refs/v/1.1.5) |
| npm | @radix-ui/react-context | 1.3.0 | MIT | [Source](https://www.npmjs.com/package/@radix-ui/react-context/v/1.3.0) |
| npm | @radix-ui/react-direction | 1.2.0 | MIT | [Source](https://www.npmjs.com/package/@radix-ui/react-direction/v/1.2.0) |
| npm | @radix-ui/react-dismissable-layer | 1.2.1 | MIT | [Source](https://www.npmjs.com/package/@radix-ui/react-dismissable-layer/v/1.2.1) |
| npm | @radix-ui/react-focus-guards | 1.2.0 | MIT | [Source](https://www.npmjs.com/package/@radix-ui/react-focus-guards/v/1.2.0) |
| npm | @radix-ui/react-focus-scope | 1.3.1 | MIT | [Source](https://www.npmjs.com/package/@radix-ui/react-focus-scope/v/1.3.1) |
| npm | @radix-ui/react-id | 1.1.4 | MIT | [Source](https://www.npmjs.com/package/@radix-ui/react-id/v/1.1.4) |
| npm | @radix-ui/react-popper | 1.4.0 | MIT | [Source](https://www.npmjs.com/package/@radix-ui/react-popper/v/1.4.0) |
| npm | @radix-ui/react-portal | 1.2.0 | MIT | [Source](https://www.npmjs.com/package/@radix-ui/react-portal/v/1.2.0) |
| npm | @radix-ui/react-presence | 1.1.11 | MIT | [Source](https://www.npmjs.com/package/@radix-ui/react-presence/v/1.1.11) |
| npm | @radix-ui/react-primitive | 2.2.0 | MIT | [Source](https://www.npmjs.com/package/@radix-ui/react-primitive/v/2.2.0) |
| npm | @radix-ui/react-select | 2.4.1 | MIT | [Source](https://www.npmjs.com/package/@radix-ui/react-select/v/2.4.1) |
| npm | @radix-ui/react-slot | 1.5.0 | MIT | [Source](https://www.npmjs.com/package/@radix-ui/react-slot/v/1.5.0) |
| npm | @radix-ui/react-use-callback-ref | 1.1.5 | MIT | [Source](https://www.npmjs.com/package/@radix-ui/react-use-callback-ref/v/1.1.5) |
| npm | @radix-ui/react-use-controllable-state | 1.3.0 | MIT | [Source](https://www.npmjs.com/package/@radix-ui/react-use-controllable-state/v/1.3.0) |
| npm | @radix-ui/react-use-effect-event | 0.0.5 | MIT | [Source](https://www.npmjs.com/package/@radix-ui/react-use-effect-event/v/0.0.5) |
| npm | @radix-ui/react-use-layout-effect | 1.1.4 | MIT | [Source](https://www.npmjs.com/package/@radix-ui/react-use-layout-effect/v/1.1.4) |
| npm | @radix-ui/react-use-rect | 1.1.4 | MIT | [Source](https://www.npmjs.com/package/@radix-ui/react-use-rect/v/1.1.4) |
| npm | @radix-ui/react-use-size | 1.1.5 | MIT | [Source](https://www.npmjs.com/package/@radix-ui/react-use-size/v/1.1.5) |
| npm | @radix-ui/react-visually-hidden | 1.2.13 | MIT | [Source](https://www.npmjs.com/package/@radix-ui/react-visually-hidden/v/1.2.13) |
| npm | @radix-ui/rect | 1.1.3 | MIT | [Source](https://www.npmjs.com/package/@radix-ui/rect/v/1.1.3) |
| npm | @tauri-apps/api | 2.12.4 | Apache-2.0 OR MIT | [Source](https://www.npmjs.com/package/@tauri-apps/api/v/2.12.4) |
| npm | @types/debug | 4.1.13 | MIT | [Source](https://www.npmjs.com/package/@types/debug/v/4.1.13) |
| npm | @types/estree-jsx | 1.0.5 | MIT | [Source](https://www.npmjs.com/package/@types/estree-jsx/v/1.0.5) |
| npm | @types/estree | 1.0.10 | MIT | [Source](https://www.npmjs.com/package/@types/estree/v/1.0.10) |
| npm | @types/hast | 3.0.5 | MIT | [Source](https://www.npmjs.com/package/@types/hast/v/3.0.5) |
| npm | @types/mdast | 4.0.4 | MIT | [Source](https://www.npmjs.com/package/@types/mdast/v/4.0.4) |
| npm | @types/ms | 2.1.0 | MIT | [Source](https://www.npmjs.com/package/@types/ms/v/2.1.0) |
| npm | @types/prismjs | 1.26.6 | MIT | [Source](https://www.npmjs.com/package/@types/prismjs/v/1.26.6) |
| npm | @types/react-dom | 19.3.0 | MIT | [Source](https://www.npmjs.com/package/@types/react-dom/v/19.3.0) |
| npm | @types/react | 19.3.0 | MIT | [Source](https://www.npmjs.com/package/@types/react/v/19.3.0) |
| npm | @types/unist | 2.0.11 | MIT | [Source](https://www.npmjs.com/package/@types/unist/v/2.0.11) |
| npm | @types/unist | 3.0.3 | MIT | [Source](https://www.npmjs.com/package/@types/unist/v/3.0.3) |
| npm | @ungap/structured-clone | 1.4.0 | ISC | [Source](https://www.npmjs.com/package/@ungap/structured-clone/v/1.4.0) |
| npm | @xterm/addon-fit | 0.11.0 | MIT | [Source](https://www.npmjs.com/package/@xterm/addon-fit/v/0.11.0) |
| npm | @xterm/addon-web-links | 0.12.0 | MIT | [Source](https://www.npmjs.com/package/@xterm/addon-web-links/v/0.12.0) |
| npm | @xterm/xterm | 6.0.0 | MIT | [Source](https://www.npmjs.com/package/@xterm/xterm/v/6.0.0) |
| npm | accepts | 2.0.0 | MIT | [Source](https://www.npmjs.com/package/accepts/v/2.0.0) |
| npm | ajv-formats | 3.0.1 | MIT | [Source](https://www.npmjs.com/package/ajv-formats/v/3.0.1) |
| npm | ajv | 8.20.0 | MIT | [Source](https://www.npmjs.com/package/ajv/v/8.20.0) |
| npm | aria-hidden | 1.2.6 | MIT | [Source](https://www.npmjs.com/package/aria-hidden/v/1.2.6) |
| npm | bail | 2.0.2 | MIT | [Source](https://www.npmjs.com/package/bail/v/2.0.2) |
| npm | body-parser | 2.4.0 | MIT | [Source](https://www.npmjs.com/package/body-parser/v/2.4.0) |
| npm | bytes | 3.1.2 | MIT | [Source](https://www.npmjs.com/package/bytes/v/3.1.2) |
| npm | call-bind-apply-helpers | 1.0.2 | MIT | [Source](https://www.npmjs.com/package/call-bind-apply-helpers/v/1.0.2) |
| npm | call-bound | 1.0.4 | MIT | [Source](https://www.npmjs.com/package/call-bound/v/1.0.4) |
| npm | ccount | 2.0.1 | MIT | [Source](https://www.npmjs.com/package/ccount/v/2.0.1) |
| npm | character-entities-html4 | 2.1.0 | MIT | [Source](https://www.npmjs.com/package/character-entities-html4/v/2.1.0) |
| npm | character-entities-legacy | 3.0.0 | MIT | [Source](https://www.npmjs.com/package/character-entities-legacy/v/3.0.0) |
| npm | character-entities | 2.0.2 | MIT | [Source](https://www.npmjs.com/package/character-entities/v/2.0.2) |
| npm | character-reference-invalid | 2.0.1 | MIT | [Source](https://www.npmjs.com/package/character-reference-invalid/v/2.0.1) |
| npm | clsx | 2.1.1 | MIT | [Source](https://www.npmjs.com/package/clsx/v/2.1.1) |
| npm | comma-separated-tokens | 2.0.3 | MIT | [Source](https://www.npmjs.com/package/comma-separated-tokens/v/2.0.3) |
| npm | content-disposition | 2.0.1 | MIT | [Source](https://www.npmjs.com/package/content-disposition/v/2.0.1) |
| npm | content-type | 1.0.5 | MIT | [Source](https://www.npmjs.com/package/content-type/v/1.0.5) |
| npm | content-type | 2.1.0 | MIT | [Source](https://www.npmjs.com/package/content-type/v/2.1.0) |
| npm | content-type | 2.1.0 | MIT | [Source](https://www.npmjs.com/package/content-type/v/2.1.0) |
| npm | content-type | 2.1.0 | MIT | [Source](https://www.npmjs.com/package/content-type/v/2.1.0) |
| npm | content-type | 2.1.0 | MIT | [Source](https://www.npmjs.com/package/content-type/v/2.1.0) |
| npm | cookie-signature | 1.2.2 | MIT | [Source](https://www.npmjs.com/package/cookie-signature/v/1.2.2) |
| npm | cookie | 0.7.2 | MIT | [Source](https://www.npmjs.com/package/cookie/v/0.7.2) |
| npm | core-util-is | 1.0.3 | MIT | [Source](https://www.npmjs.com/package/core-util-is/v/1.0.3) |
| npm | cors | 2.8.6 | MIT | [Source](https://www.npmjs.com/package/cors/v/2.8.6) |
| npm | cross-spawn | 7.0.6 | MIT | [Source](https://www.npmjs.com/package/cross-spawn/v/7.0.6) |
| npm | csstype | 3.2.3 | MIT | [Source](https://www.npmjs.com/package/csstype/v/3.2.3) |
| npm | debug | 4.4.3 | MIT | [Source](https://www.npmjs.com/package/debug/v/4.4.3) |
| npm | decode-named-character-reference | 1.3.0 | MIT | [Source](https://www.npmjs.com/package/decode-named-character-reference/v/1.3.0) |
| npm | depd | 2.0.0 | MIT | [Source](https://www.npmjs.com/package/depd/v/2.0.0) |
| npm | dequal | 2.0.3 | MIT | [Source](https://www.npmjs.com/package/dequal/v/2.0.3) |
| npm | detect-node-es | 1.1.0 | MIT | [Source](https://www.npmjs.com/package/detect-node-es/v/1.1.0) |
| npm | devlop | 1.1.0 | MIT | [Source](https://www.npmjs.com/package/devlop/v/1.1.0) |
| npm | diff | 9.0.0 | BSD-3-Clause | [Source](https://www.npmjs.com/package/diff/v/9.0.0) |
| npm | docx-preview | 0.4.1 | Apache-2.0 | [Source](https://www.npmjs.com/package/docx-preview/v/0.4.1) |
| npm | dunder-proto | 1.0.1 | MIT | [Source](https://www.npmjs.com/package/dunder-proto/v/1.0.1) |
| npm | echarts | 6.1.0 | Apache-2.0 | [Source](https://www.npmjs.com/package/echarts/v/6.1.0) |
| npm | ee-first | 1.1.1 | MIT | [Source](https://www.npmjs.com/package/ee-first/v/1.1.1) |
| npm | encodeurl | 2.0.3 | MIT | [Source](https://www.npmjs.com/package/encodeurl/v/2.0.3) |
| npm | es-define-property | 1.0.1 | MIT | [Source](https://www.npmjs.com/package/es-define-property/v/1.0.1) |
| npm | es-errors | 1.3.0 | MIT | [Source](https://www.npmjs.com/package/es-errors/v/1.3.0) |
| npm | es-object-atoms | 1.1.2 | MIT | [Source](https://www.npmjs.com/package/es-object-atoms/v/1.1.2) |
| npm | escape-html | 1.0.3 | MIT | [Source](https://www.npmjs.com/package/escape-html/v/1.0.3) |
| npm | escape-string-regexp | 5.0.0 | MIT | [Source](https://www.npmjs.com/package/escape-string-regexp/v/5.0.0) |
| npm | estree-util-is-identifier-name | 3.0.0 | MIT | [Source](https://www.npmjs.com/package/estree-util-is-identifier-name/v/3.0.0) |
| npm | etag | 1.8.1 | MIT | [Source](https://www.npmjs.com/package/etag/v/1.8.1) |
| npm | eventsource-parser | 3.1.1 | MIT | [Source](https://www.npmjs.com/package/eventsource-parser/v/3.1.1) |
| npm | eventsource | 3.0.7 | MIT | [Source](https://www.npmjs.com/package/eventsource/v/3.0.7) |
| npm | express-rate-limit | 8.7.4 | MIT | [Source](https://www.npmjs.com/package/express-rate-limit/v/8.7.4) |
| npm | express | 5.3.0 | MIT | [Source](https://www.npmjs.com/package/express/v/5.3.0) |
| npm | extend | 3.0.2 | MIT | [Source](https://www.npmjs.com/package/extend/v/3.0.2) |
| npm | fast-deep-equal | 3.1.3 | MIT | [Source](https://www.npmjs.com/package/fast-deep-equal/v/3.1.3) |
| npm | fast-uri | 3.1.9 | BSD-3-Clause | [Source](https://www.npmjs.com/package/fast-uri/v/3.1.9) |
| npm | fflate | 0.8.3 | MIT | [Source](https://www.npmjs.com/package/fflate/v/0.8.3) |
| npm | finalhandler | 2.1.1 | MIT | [Source](https://www.npmjs.com/package/finalhandler/v/2.1.1) |
| npm | forwarded | 0.2.0 | MIT | [Source](https://www.npmjs.com/package/forwarded/v/0.2.0) |
| npm | fresh | 2.0.0 | MIT | [Source](https://www.npmjs.com/package/fresh/v/2.0.0) |
| npm | function-bind | 1.1.2 | MIT | [Source](https://www.npmjs.com/package/function-bind/v/1.1.2) |
| npm | get-intrinsic | 1.3.0 | MIT | [Source](https://www.npmjs.com/package/get-intrinsic/v/1.3.0) |
| npm | get-nonce | 1.0.1 | MIT | [Source](https://www.npmjs.com/package/get-nonce/v/1.0.1) |
| npm | get-proto | 1.0.1 | MIT | [Source](https://www.npmjs.com/package/get-proto/v/1.0.1) |
| npm | gopd | 1.2.0 | MIT | [Source](https://www.npmjs.com/package/gopd/v/1.2.0) |
| npm | graceful-fs | 4.2.12 | BlueOak-1.0.0 | [Source](https://www.npmjs.com/package/graceful-fs/v/4.2.12) |
| npm | has-symbols | 1.1.0 | MIT | [Source](https://www.npmjs.com/package/has-symbols/v/1.1.0) |
| npm | hasown | 2.0.4 | MIT | [Source](https://www.npmjs.com/package/hasown/v/2.0.4) |
| npm | hast-util-to-jsx-runtime | 2.3.7 | MIT | [Source](https://www.npmjs.com/package/hast-util-to-jsx-runtime/v/2.3.7) |
| npm | hast-util-whitespace | 3.0.0 | MIT | [Source](https://www.npmjs.com/package/hast-util-whitespace/v/3.0.0) |
| npm | hono | 4.13.18 | MIT | [Source](https://www.npmjs.com/package/hono/v/4.13.18) |
| npm | html-url-attributes | 3.0.1 | MIT | [Source](https://www.npmjs.com/package/html-url-attributes/v/3.0.1) |
| npm | http-errors | 2.0.1 | MIT | [Source](https://www.npmjs.com/package/http-errors/v/2.0.1) |
| npm | iconv-lite | 0.7.3 | MIT | [Source](https://www.npmjs.com/package/iconv-lite/v/0.7.3) |
| npm | immediate | 3.0.6 | MIT | [Source](https://www.npmjs.com/package/immediate/v/3.0.6) |
| npm | inherits | 2.0.4 | ISC | [Source](https://www.npmjs.com/package/inherits/v/2.0.4) |
| npm | inline-style-parser | 0.2.9 | MIT | [Source](https://www.npmjs.com/package/inline-style-parser/v/0.2.9) |
| npm | ip-address | 10.7.6 | MIT | [Source](https://www.npmjs.com/package/ip-address/v/10.7.6) |
| npm | ipaddr.js | 1.9.1 | MIT | [Source](https://www.npmjs.com/package/ipaddr.js/v/1.9.1) |
| npm | is-alphabetical | 2.0.1 | MIT | [Source](https://www.npmjs.com/package/is-alphabetical/v/2.0.1) |
| npm | is-alphanumerical | 2.0.1 | MIT | [Source](https://www.npmjs.com/package/is-alphanumerical/v/2.0.1) |
| npm | is-decimal | 2.0.1 | MIT | [Source](https://www.npmjs.com/package/is-decimal/v/2.0.1) |
| npm | is-hexadecimal | 2.0.1 | MIT | [Source](https://www.npmjs.com/package/is-hexadecimal/v/2.0.1) |
| npm | is-plain-obj | 4.1.0 | MIT | [Source](https://www.npmjs.com/package/is-plain-obj/v/4.1.0) |
| npm | is-promise | 4.0.0 | MIT | [Source](https://www.npmjs.com/package/is-promise/v/4.0.0) |
| npm | isarray | 1.0.0 | MIT | [Source](https://www.npmjs.com/package/isarray/v/1.0.0) |
| npm | isexe | 2.0.0 | ISC | [Source](https://www.npmjs.com/package/isexe/v/2.0.0) |
| npm | isomorphic.js | 0.2.5 | MIT | [Source](https://www.npmjs.com/package/isomorphic.js/v/0.2.5) |
| npm | jose | 6.2.17 | MIT | [Source](https://www.npmjs.com/package/jose/v/6.2.17) |
| npm | json-schema-traverse | 1.0.0 | MIT | [Source](https://www.npmjs.com/package/json-schema-traverse/v/1.0.0) |
| npm | json-schema-typed | 8.0.2 | BSD-2-Clause | [Source](https://www.npmjs.com/package/json-schema-typed/v/8.0.2) |
| npm | jszip | 3.10.2 | (MIT OR GPL-3.0-or-later) | [Source](https://www.npmjs.com/package/jszip/v/3.10.2) |
| npm | lib0 | 0.2.120 | MIT | [Source](https://www.npmjs.com/package/lib0/v/0.2.120) |
| npm | lie | 3.3.0 | MIT | [Source](https://www.npmjs.com/package/lie/v/3.3.0) |
| npm | longest-streak | 3.1.0 | MIT | [Source](https://www.npmjs.com/package/longest-streak/v/3.1.0) |
| npm | lucide-react | 1.72.0 | ISC | [Source](https://www.npmjs.com/package/lucide-react/v/1.72.0) |
| npm | markdown-table | 3.1.0 | MIT | [Source](https://www.npmjs.com/package/markdown-table/v/3.1.0) |
| npm | math-intrinsics | 1.1.0 | MIT | [Source](https://www.npmjs.com/package/math-intrinsics/v/1.1.0) |
| npm | mdast-util-find-and-replace | 3.0.4 | MIT | [Source](https://www.npmjs.com/package/mdast-util-find-and-replace/v/3.0.4) |
| npm | mdast-util-from-markdown | 2.1.0 | MIT | [Source](https://www.npmjs.com/package/mdast-util-from-markdown/v/2.1.0) |
| npm | mdast-util-gfm-autolink-literal | 2.1.0 | MIT | [Source](https://www.npmjs.com/package/mdast-util-gfm-autolink-literal/v/2.1.0) |
| npm | mdast-util-gfm-footnote | 2.1.0 | MIT | [Source](https://www.npmjs.com/package/mdast-util-gfm-footnote/v/2.1.0) |
| npm | mdast-util-gfm-strikethrough | 2.0.1 | MIT | [Source](https://www.npmjs.com/package/mdast-util-gfm-strikethrough/v/2.0.1) |
| npm | mdast-util-gfm-table | 2.0.1 | MIT | [Source](https://www.npmjs.com/package/mdast-util-gfm-table/v/2.0.1) |
| npm | mdast-util-gfm-task-list-item | 2.0.1 | MIT | [Source](https://www.npmjs.com/package/mdast-util-gfm-task-list-item/v/2.0.1) |
| npm | mdast-util-gfm | 3.1.0 | MIT | [Source](https://www.npmjs.com/package/mdast-util-gfm/v/3.1.0) |
| npm | mdast-util-mdx-expression | 2.0.1 | MIT | [Source](https://www.npmjs.com/package/mdast-util-mdx-expression/v/2.0.1) |
| npm | mdast-util-mdx-jsx | 3.2.1 | MIT | [Source](https://www.npmjs.com/package/mdast-util-mdx-jsx/v/3.2.1) |
| npm | mdast-util-mdxjs-esm | 2.0.1 | MIT | [Source](https://www.npmjs.com/package/mdast-util-mdxjs-esm/v/2.0.1) |
| npm | mdast-util-phrasing | 4.1.0 | MIT | [Source](https://www.npmjs.com/package/mdast-util-phrasing/v/4.1.0) |
| npm | mdast-util-to-hast | 13.2.2 | MIT | [Source](https://www.npmjs.com/package/mdast-util-to-hast/v/13.2.2) |
| npm | mdast-util-to-markdown | 2.2.3 | MIT | [Source](https://www.npmjs.com/package/mdast-util-to-markdown/v/2.2.3) |
| npm | mdast-util-to-string | 4.0.0 | MIT | [Source](https://www.npmjs.com/package/mdast-util-to-string/v/4.0.0) |
| npm | media-typer | 1.1.1 | MIT | [Source](https://www.npmjs.com/package/media-typer/v/1.1.1) |
| npm | merge-descriptors | 2.0.0 | MIT | [Source](https://www.npmjs.com/package/merge-descriptors/v/2.0.0) |
| npm | micromark-core-commonmark | 2.0.4 | MIT | [Source](https://www.npmjs.com/package/micromark-core-commonmark/v/2.0.4) |
| npm | micromark-extension-gfm-autolink-literal | 2.1.0 | MIT | [Source](https://www.npmjs.com/package/micromark-extension-gfm-autolink-literal/v/2.1.0) |
| npm | micromark-extension-gfm-footnote | 2.1.0 | MIT | [Source](https://www.npmjs.com/package/micromark-extension-gfm-footnote/v/2.1.0) |
| npm | micromark-extension-gfm-strikethrough | 2.1.0 | MIT | [Source](https://www.npmjs.com/package/micromark-extension-gfm-strikethrough/v/2.1.0) |
| npm | micromark-extension-gfm-table | 2.1.2 | MIT | [Source](https://www.npmjs.com/package/micromark-extension-gfm-table/v/2.1.2) |
| npm | micromark-extension-gfm-tagfilter | 2.0.0 | MIT | [Source](https://www.npmjs.com/package/micromark-extension-gfm-tagfilter/v/2.0.0) |
| npm | micromark-extension-gfm-task-list-item | 2.1.0 | MIT | [Source](https://www.npmjs.com/package/micromark-extension-gfm-task-list-item/v/2.1.0) |
| npm | micromark-extension-gfm | 3.0.0 | MIT | [Source](https://www.npmjs.com/package/micromark-extension-gfm/v/3.0.0) |
| npm | micromark-factory-destination | 2.0.1 | MIT | [Source](https://www.npmjs.com/package/micromark-factory-destination/v/2.0.1) |
| npm | micromark-factory-label | 2.0.1 | MIT | [Source](https://www.npmjs.com/package/micromark-factory-label/v/2.0.1) |
| npm | micromark-factory-space | 2.1.0 | MIT | [Source](https://www.npmjs.com/package/micromark-factory-space/v/2.1.0) |
| npm | micromark-factory-title | 2.0.1 | MIT | [Source](https://www.npmjs.com/package/micromark-factory-title/v/2.0.1) |
| npm | micromark-factory-whitespace | 2.0.1 | MIT | [Source](https://www.npmjs.com/package/micromark-factory-whitespace/v/2.0.1) |
| npm | micromark-util-character | 2.1.1 | MIT | [Source](https://www.npmjs.com/package/micromark-util-character/v/2.1.1) |
| npm | micromark-util-chunked | 2.0.1 | MIT | [Source](https://www.npmjs.com/package/micromark-util-chunked/v/2.0.1) |
| npm | micromark-util-classify-character | 2.0.1 | MIT | [Source](https://www.npmjs.com/package/micromark-util-classify-character/v/2.0.1) |
| npm | micromark-util-combine-extensions | 2.0.1 | MIT | [Source](https://www.npmjs.com/package/micromark-util-combine-extensions/v/2.0.1) |
| npm | micromark-util-decode-numeric-character-reference | 2.0.2 | MIT | [Source](https://www.npmjs.com/package/micromark-util-decode-numeric-character-reference/v/2.0.2) |
| npm | micromark-util-decode-string | 2.0.1 | MIT | [Source](https://www.npmjs.com/package/micromark-util-decode-string/v/2.0.1) |
| npm | micromark-util-edit-map | 1.0.0 | MIT | [Source](https://www.npmjs.com/package/micromark-util-edit-map/v/1.0.0) |
| npm | micromark-util-encode | 2.0.1 | MIT | [Source](https://www.npmjs.com/package/micromark-util-encode/v/2.0.1) |
| npm | micromark-util-html-tag-name | 2.0.1 | MIT | [Source](https://www.npmjs.com/package/micromark-util-html-tag-name/v/2.0.1) |
| npm | micromark-util-normalize-identifier | 2.0.1 | MIT | [Source](https://www.npmjs.com/package/micromark-util-normalize-identifier/v/2.0.1) |
| npm | micromark-util-resolve-all | 2.0.1 | MIT | [Source](https://www.npmjs.com/package/micromark-util-resolve-all/v/2.0.1) |
| npm | micromark-util-sanitize-uri | 2.0.1 | MIT | [Source](https://www.npmjs.com/package/micromark-util-sanitize-uri/v/2.0.1) |
| npm | micromark-util-subtokenize | 2.1.0 | MIT | [Source](https://www.npmjs.com/package/micromark-util-subtokenize/v/2.1.0) |
| npm | micromark-util-symbol | 2.0.1 | MIT | [Source](https://www.npmjs.com/package/micromark-util-symbol/v/2.0.1) |
| npm | micromark-util-types | 2.0.3 | MIT | [Source](https://www.npmjs.com/package/micromark-util-types/v/2.0.3) |
| npm | micromark | 4.0.3 | MIT | [Source](https://www.npmjs.com/package/micromark/v/4.0.3) |
| npm | mime-db | 1.54.0 | MIT | [Source](https://www.npmjs.com/package/mime-db/v/1.54.0) |
| npm | mime-types | 3.0.2 | MIT | [Source](https://www.npmjs.com/package/mime-types/v/3.0.2) |
| npm | ms | 2.1.3 | MIT | [Source](https://www.npmjs.com/package/ms/v/2.1.3) |
| npm | mtx-decompressor | 1.8.1 | MPL-2.0 | [Source](https://github.com/ChristopherVR/mtx-decompressor/tree/d4a554a4ea8126aac0ab00a1fe8253e0ffd316d4) |
| npm | negotiator | 1.1.0 | MIT | [Source](https://www.npmjs.com/package/negotiator/v/1.1.0) |
| npm | node-int64 | 0.4.0 | MIT | [Source](https://www.npmjs.com/package/node-int64/v/0.4.0) |
| npm | object-assign | 4.1.1 | MIT | [Source](https://www.npmjs.com/package/object-assign/v/4.1.1) |
| npm | object-inspect | 1.13.4 | MIT | [Source](https://www.npmjs.com/package/object-inspect/v/1.13.4) |
| npm | on-finished | 2.4.2 | MIT | [Source](https://www.npmjs.com/package/on-finished/v/2.4.2) |
| npm | once | 1.4.0 | ISC | [Source](https://www.npmjs.com/package/once/v/1.4.0) |
| npm | pako | 1.0.11 | (MIT AND Zlib) | [Source](https://www.npmjs.com/package/pako/v/1.0.11) |
| npm | parse-entities | 4.0.2 | MIT | [Source](https://www.npmjs.com/package/parse-entities/v/4.0.2) |
| npm | parseurl | 1.3.3 | MIT | [Source](https://www.npmjs.com/package/parseurl/v/1.3.3) |
| npm | path-key | 3.1.1 | MIT | [Source](https://www.npmjs.com/package/path-key/v/3.1.1) |
| npm | path-to-regexp | 8.4.2 | MIT | [Source](https://www.npmjs.com/package/path-to-regexp/v/8.4.2) |
| npm | pdfjs-dist | 6.5.438 | Apache-2.0 | [Source](https://www.npmjs.com/package/pdfjs-dist/v/6.5.438) |
| npm | pkce-challenge | 5.0.1 | MIT | [Source](https://www.npmjs.com/package/pkce-challenge/v/5.0.1) |
| npm | playwright-core | 1.65.1 | Apache-2.0 | [Source](https://www.npmjs.com/package/playwright-core/v/1.65.1) |
| npm | prism-react-renderer | 2.4.1 | MIT | [Source](https://www.npmjs.com/package/prism-react-renderer/v/2.4.1) |
| npm | process-nextick-args | 2.0.1 | MIT | [Source](https://www.npmjs.com/package/process-nextick-args/v/2.0.1) |
| npm | property-information | 7.2.0 | MIT | [Source](https://www.npmjs.com/package/property-information/v/7.2.0) |
| npm | proxy-addr | 2.0.8 | MIT | [Source](https://www.npmjs.com/package/proxy-addr/v/2.0.8) |
| npm | qs | 6.17.1 | BSD-3-Clause | [Source](https://www.npmjs.com/package/qs/v/6.17.1) |
| npm | range-parser | 1.3.0 | MIT | [Source](https://www.npmjs.com/package/range-parser/v/1.3.0) |
| npm | raw-body | 3.0.2 | MIT | [Source](https://www.npmjs.com/package/raw-body/v/3.0.2) |
| npm | react-dom | 19.3.1 | MIT | [Source](https://www.npmjs.com/package/react-dom/v/19.3.1) |
| npm | react-markdown | 10.1.0 | MIT | [Source](https://www.npmjs.com/package/react-markdown/v/10.1.0) |
| npm | react-remove-scroll-bar | 2.3.8 | MIT | [Source](https://www.npmjs.com/package/react-remove-scroll-bar/v/2.3.8) |
| npm | react-remove-scroll | 2.7.2 | MIT | [Source](https://www.npmjs.com/package/react-remove-scroll/v/2.7.2) |
| npm | react-style-singleton | 2.2.3 | MIT | [Source](https://www.npmjs.com/package/react-style-singleton/v/2.2.3) |
| npm | react | 19.3.1 | MIT | [Source](https://www.npmjs.com/package/react/v/19.3.1) |
| npm | read-excel-file | 9.3.17 | MIT | [Source](https://www.npmjs.com/package/read-excel-file/v/9.3.17) |
| npm | readable-stream | 2.3.8 | MIT | [Source](https://www.npmjs.com/package/readable-stream/v/2.3.8) |
| npm | remark-gfm | 4.0.1 | MIT | [Source](https://www.npmjs.com/package/remark-gfm/v/4.0.1) |
| npm | remark-parse | 11.0.0 | MIT | [Source](https://www.npmjs.com/package/remark-parse/v/11.0.0) |
| npm | remark-rehype | 11.1.2 | MIT | [Source](https://www.npmjs.com/package/remark-rehype/v/11.1.2) |
| npm | remark-stringify | 11.0.0 | MIT | [Source](https://www.npmjs.com/package/remark-stringify/v/11.0.0) |
| npm | require-from-string | 2.0.2 | MIT | [Source](https://www.npmjs.com/package/require-from-string/v/2.0.2) |
| npm | router | 2.2.0 | MIT | [Source](https://www.npmjs.com/package/router/v/2.2.0) |
| npm | safe-buffer | 5.1.2 | MIT | [Source](https://www.npmjs.com/package/safe-buffer/v/5.1.2) |
| npm | safer-buffer | 2.1.2 | MIT | [Source](https://www.npmjs.com/package/safer-buffer/v/2.1.2) |
| npm | saxen | 11.2.0 | MIT | [Source](https://www.npmjs.com/package/saxen/v/11.2.0) |
| npm | scheduler | 0.28.0 | MIT | [Source](https://www.npmjs.com/package/scheduler/v/0.28.0) |
| npm | send | 1.2.1 | MIT | [Source](https://www.npmjs.com/package/send/v/1.2.1) |
| npm | serve-static | 2.2.1 | MIT | [Source](https://www.npmjs.com/package/serve-static/v/2.2.1) |
| npm | setimmediate | 1.0.5 | MIT | [Source](https://www.npmjs.com/package/setimmediate/v/1.0.5) |
| npm | setprototypeof | 1.2.0 | ISC | [Source](https://www.npmjs.com/package/setprototypeof/v/1.2.0) |
| npm | shebang-command | 2.0.0 | MIT | [Source](https://www.npmjs.com/package/shebang-command/v/2.0.0) |
| npm | shebang-regex | 3.0.0 | MIT | [Source](https://www.npmjs.com/package/shebang-regex/v/3.0.0) |
| npm | side-channel-list | 1.0.1 | MIT | [Source](https://www.npmjs.com/package/side-channel-list/v/1.0.1) |
| npm | side-channel-map | 1.0.1 | MIT | [Source](https://www.npmjs.com/package/side-channel-map/v/1.0.1) |
| npm | side-channel-weakmap | 1.0.2 | MIT | [Source](https://www.npmjs.com/package/side-channel-weakmap/v/1.0.2) |
| npm | side-channel | 1.1.1 | MIT | [Source](https://www.npmjs.com/package/side-channel/v/1.1.1) |
| npm | space-separated-tokens | 2.0.2 | MIT | [Source](https://www.npmjs.com/package/space-separated-tokens/v/2.0.2) |
| npm | statuses | 2.0.2 | MIT | [Source](https://www.npmjs.com/package/statuses/v/2.0.2) |
| npm | string_decoder | 1.1.1 | MIT | [Source](https://www.npmjs.com/package/string_decoder/v/1.1.1) |
| npm | stringify-entities | 4.0.4 | MIT | [Source](https://www.npmjs.com/package/stringify-entities/v/4.0.4) |
| npm | style-to-object | 2.0.2 | MIT | [Source](https://www.npmjs.com/package/style-to-object/v/2.0.2) |
| npm | toidentifier | 1.0.1 | MIT | [Source](https://www.npmjs.com/package/toidentifier/v/1.0.1) |
| npm | trim-lines | 3.0.1 | MIT | [Source](https://www.npmjs.com/package/trim-lines/v/3.0.1) |
| npm | trough | 2.2.0 | MIT | [Source](https://www.npmjs.com/package/trough/v/2.2.0) |
| npm | tslib | 2.3.0 | 0BSD | [Source](https://www.npmjs.com/package/tslib/v/2.3.0) |
| npm | tslib | 2.3.0 | 0BSD | [Source](https://www.npmjs.com/package/tslib/v/2.3.0) |
| npm | tslib | 2.9.1 | 0BSD | [Source](https://www.npmjs.com/package/tslib/v/2.9.1) |
| npm | type-is | 2.1.0 | MIT | [Source](https://www.npmjs.com/package/type-is/v/2.1.0) |
| npm | unified | 11.0.5 | MIT | [Source](https://www.npmjs.com/package/unified/v/11.0.5) |
| npm | unist-util-is | 6.0.1 | MIT | [Source](https://www.npmjs.com/package/unist-util-is/v/6.0.1) |
| npm | unist-util-position | 5.0.0 | MIT | [Source](https://www.npmjs.com/package/unist-util-position/v/5.0.0) |
| npm | unist-util-stringify-position | 4.0.0 | MIT | [Source](https://www.npmjs.com/package/unist-util-stringify-position/v/4.0.0) |
| npm | unist-util-visit-parents | 6.1.0 | MIT | [Source](https://www.npmjs.com/package/unist-util-visit-parents/v/6.1.0) |
| npm | unist-util-visit | 5.2.0 | MIT | [Source](https://www.npmjs.com/package/unist-util-visit/v/5.2.0) |
| npm | unpipe | 1.0.0 | MIT | [Source](https://www.npmjs.com/package/unpipe/v/1.0.0) |
| npm | unzipper-esm | 0.13.3 | MIT | [Source](https://www.npmjs.com/package/unzipper-esm/v/0.13.3) |
| npm | use-callback-ref | 1.3.3 | MIT | [Source](https://www.npmjs.com/package/use-callback-ref/v/1.3.3) |
| npm | use-sidecar | 1.1.3 | MIT | [Source](https://www.npmjs.com/package/use-sidecar/v/1.1.3) |
| npm | util-deprecate | 1.0.2 | MIT | [Source](https://www.npmjs.com/package/util-deprecate/v/1.0.2) |
| npm | vary | 1.1.2 | MIT | [Source](https://www.npmjs.com/package/vary/v/1.1.2) |
| npm | vfile-message | 4.0.4 | MIT | [Source](https://www.npmjs.com/package/vfile-message/v/4.0.4) |
| npm | vfile | 6.0.3 | MIT | [Source](https://www.npmjs.com/package/vfile/v/6.0.3) |
| npm | which | 2.0.2 | ISC | [Source](https://www.npmjs.com/package/which/v/2.0.2) |
| npm | worker-f | 0.1.24 | MIT | [Source](https://www.npmjs.com/package/worker-f/v/0.1.24) |
| npm | wrappy | 1.0.2 | ISC | [Source](https://www.npmjs.com/package/wrappy/v/1.0.2) |
| npm | yjs | 13.6.33 | MIT | [Source](https://www.npmjs.com/package/yjs/v/13.6.33) |
| npm | zod-to-json-schema | 3.25.2 | ISC | [Source](https://www.npmjs.com/package/zod-to-json-schema/v/3.25.2) |
| npm | zod | 4.6.7 | MIT | [Source](https://www.npmjs.com/package/zod/v/4.6.7) |
| npm | zrender | 6.1.0 | BSD-3-Clause | [Source](https://www.npmjs.com/package/zrender/v/6.1.0) |
| npm | zwitch | 2.0.4 | MIT | [Source](https://www.npmjs.com/package/zwitch/v/2.0.4) |

Regenerate with `cargo metadata --locked --format-version 1 --manifest-path src-tauri/Cargo.toml`
and `node scripts/third-party-notices.mjs <metadata-file>`. See
[third_party/inventory.json](third_party/inventory.json) for original-notice file hashes.

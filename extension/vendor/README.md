# Vendored, not fetched

Manifest V3 forbids remote code, so the two libraries one-click trading needs
on Robinhood Chain are copied in rather than installed:

| file             | from                          | why                                    |
|------------------|-------------------------------|----------------------------------------|
| `secp256k1.js`   | `@noble/secp256k1` 3.2.0      | Ethereum's signing curve, which WebCrypto does not implement |
| `sha3.js`        | `@noble/hashes` 2.4.0         | keccak256 — addresses and transaction hashes |
| `_u64.js`        | `@noble/hashes` 2.4.0         | sha3's 64-bit helpers                  |
| `utils.js`       | `@noble/hashes` 2.4.0         | sha3's byte helpers                    |

Unmodified. Both are MIT; the licences are beside them.

`secp256k1.js` needs no dependencies of its own — it takes SHA-256 and HMAC
from WebCrypto, which is why only its async signing path is used.

Verified before they were trusted: private keys 1, 2 and 3 derive the three
addresses everyone publishes for them, and keccak256("") is
c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470.

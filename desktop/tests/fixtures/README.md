# WhatsApp Web page fixtures

Small, hand-made snapshots of WhatsApp Web's page structure, reduced to the parts that
`src/whatsapp/selectors.ts` relies on. They contain no real chats, numbers or messages.
Tests load them into happy-dom and simulate WhatsApp's behaviour (Escape closes a chat,
clicking a search result opens it) in the test itself; the fixtures carry no scripts.

| File | Page state |
|---|---|
| `qr.html` | Not linked: the link-a-device QR screen |
| `chats.html` | Linked, chat list showing, no conversation open |
| `group-open.html` | Linked, a client's group open (`TW · TW-C-0142 · XYZ Traders`) |
| `covered-group-open.html` | Linked, a covered client's group open (`TW · TW-C-0177 · Sharma Exports`) |
| `other-chat-open.html` | Linked, another client's group open (`TW · TW-C-0201 · Patel Builders`) |
| `one-to-one-open.html` | Linked, a one-to-one chat with an unsaved number open (`+91 98450 12345`) |
| `search.html` | Linked, search box and an empty result list (results are added by the test) |
| `changed-search-box.html` | WhatsApp changed its page: the search box is gone |
| `changed-title.html` | WhatsApp changed its page: an open conversation has no readable title |
| `changed-everything.html` | WhatsApp changed its page: neither the QR screen nor the chat list is recognisable |

When `selectors.ts` changes, update these fixtures to the new structure in the same change.

# hisui-gaming-server
`WebSocket game server with compact protocol that can broadcast and store player and game states.`

This repository now also serves the [EasyRPGPlayerMultiplayerModFrontend](https://github.com/hujle/EasyRPGPlayerMultiplayerModFrontend) as an integrated web application.

## URL routing

When running, the server exposes:

| URL | Description |
|---|---|
| `/` | Game selection page (player counts, game cards) |
| `/<game>/` | Dedicated player page for that game |
| `/account` | Your own account info page (total playtime, private guest UUID) |
| `/account/<id>` | Public profile of another player by 64-bit account id |
| `/api/players` | JSON API for total/game player counts |
| `/api/users/<id>` | JSON API for a user's public profile (username) by 64-bit account id |
| `/ws` | WebSocket endpoint for multiplayer clients |
| `/easyrpg-player.html` | Standalone EasyRPG Player page |
| `/src/*`, `/styles/*`, `/games/*`, `*.wasm`, etc. | Frontend static assets |

Game routes are discovered automatically from the `frontend/games/` directory. Adding a new game folder makes its route available immediately (no backend code changes required).

## User lookup API

Resolve a user's display name from their 64-bit account id (the value returned by
`EasyRPGMultiplayer.getAccountId()` in the frontend).

```
GET /api/users/<id>
```

`<id>` is the account id as a decimal string (the same value the client received
at login/guest creation). The endpoint is public and only exposes non-sensitive
fields.

**Success `200`**

```json
{
  "id": "122202960792278850",
  "username": "SomePlayer",
  "accountType": "registered"
}
```

- `username` is the account's display name. For guests this is the persistent
  `guest_name` (may be `null` until the guest picks a name) and is **not** required
  to be unique. For registered accounts it is the unique login name.
- `accountType` is `"registered"` or `"guest"`.

**Not found `404`**

```json
{ "error": "User not found" }
```

Example:

```bash
curl https://example.com/api/users/122202960792278850
```

## Accounts and guests

Guest accounts are first-class, persistent accounts. They are created
automatically on the first visit (no user action required) and only need a
display name. Unlike registered accounts they have no password and their name
does not have to be unique.

| Method & path | Description |
|---|---|
| `POST /api/auth/guest` | Create (or return the current) guest account. Returns `accountId`, `guestUuid`, `authToken`. |
| `POST /api/auth/guest/name` | Set the current guest's display name. Body: `{ "username": "Name" }`. Persists server-side. |
| `POST /api/auth/guest/load` | Switch to an existing guest by UUID. Body: `{ "guestUuid": "..." }`. |
| `POST /api/auth/register` | Create a registered account. Body: `{ "username", "password", "guestUuid?" }`. If `guestUuid` is supplied that guest is converted; otherwise a brand-new account is created. |
| `POST /api/auth/login` | Log in with `{ "username", "password" }`. |
| `POST /api/auth/logout` | Clear the current session. |
| `GET /api/auth/me` | Current account profile (includes `playtimeTotal`, `playtimeByGame`). |
| `POST /api/account/playtime` | Add playtime. Body: `{ "gameId": "...", "seconds": 120 }`. Accumulates the total and the per-game breakdown. |
| `POST /api/auth/guest/recover` | Legacy: refresh/load a guest by UUID (kept for older clients). |

Playtime is stored per account (total plus a per-game breakdown). Because it is
keyed by account id, it is preserved automatically when a guest is converted
into a registered account. Only the total is exposed publicly; the per-game
breakdown is recorded but not displayed yet.

The guest UUID is **private**: it is only returned by `/api/auth/me` (your own
session) and is never included in the public `/api/users/<id>` profile.

The guest UUID is shown in the UI (with a copy button) so it can be pasted into
**Register** (to convert that guest) or **Load Guest Account** (to switch to it).

## Frontend dependency

The frontend is included as a Git submodule at `backend/frontend/`.

### Production / fresh clone

```bash
git clone --recurse-submodules https://github.com/hujle/hisui-gaming-server.git
cd hisui-gaming-server
npm install
node main
```

Or, if you already cloned without submodules:

```bash
git submodule update --init
npm install
node main
```

### Local development with a separate frontend checkout

If you want to work on the frontend repository separately without updating the submodule each time, copy `conf/conf.example.json` to `conf/conf.local.json` and point it at your local checkout:

```bash
cp conf/conf.example.json conf/conf.local.json
# edit conf/conf.local.json
```

Example `conf/conf.local.json`:

```json
{
  "server": {
    "frontendPath": "/path/to/EasyRPGPlayerMultiplayerModFrontend"
  }
}
```

`conf/conf.local.json` is gitignored so it will not affect other clones.

## Game data

Game folders live in the frontend repository under `frontend/games/`. After adding or removing games, regenerate the list:

```bash
cd frontend
node build-games-json.js
```

If you are using the submodule in production, commit and push the frontend changes, then update the backend submodule:

```bash
cd backend/frontend
git pull origin main
cd ../..
git add frontend
git commit -m "Update frontend submodule"
git push
```

## Protocol
### Server-to-Client
All server-to-client packets start with a single byte that specifies its type
The types are

| Value | Description |
|---|---|
| 0 | Player connected |
| 1 | Player joined current map |
| 2 | Player disconnected or left current map |
| 3 | Player data packet |
| 4 | Id of your player |

Player connected/joined/disconnected/"my id" packets
|Type|Byte offset|Description|
|---|---|---|
|UInt8|0|Packet type|
|UInt32|1|Player id|

Player data packet structure
|Type|Byte offset|Description|
|---|---|---|
|UInt8|0|Packet type|
|UInt8|1|Broadcast scope|
|UInt32|2|Data owner id|
|UInt16|6|Data slot|
|Blob|8|Stored data|


### Client-to-Server packets
All client-to-server packets start with a single byte that specify its type
The types are

| Value | Description |
|---|---|
| 0 | Switch to another map |
| 1 | Broadcast/Store data |

Connect to another map
|Type|Byte offset|Description|
|---|---|---|
|UInt8|0|Packet type|
|UInt16|1|Map number|

Broadcast/Store data

|Type|Byte offset|Description|
|---|---|---|
|UInt8|0|Packet type|
|UInt8|1|Flags mask|
|UInt16|2|Data slot|
|Blob|4|Any data that should be stored/broadcasted|

Possible flags that client can use are
|Flag description|Flag mask byte|
|---|---|
|Broadcast data to players in the same map|0|
|Broadcast data to players playing the same game|1|
|Broadcast data to whole server|2|
|Store data for this player|3|
|Store data for current map|4|
|Store data for current game|5|
|Store data for current server|6|

## Dependencies

```bash
npm install
```

This installs `express` (for static file serving and routing) and `ws` (WebSocket server).

## How to run
`node main`

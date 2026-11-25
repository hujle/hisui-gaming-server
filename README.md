# hisui-gaming-server
`WebSocket game server with compact protocol that can broadcast and store player and game states.`

This repository now also serves the [EasyRPGPlayerMultiplayerModFrontend](https://github.com/hujle/EasyRPGPlayerMultiplayerModFrontend) as an integrated web application.

## URL routing

When running, the server exposes:

| URL | Description |
|---|---|
| `/` | Game selection page (player counts, game cards) |
| `/<game>/` | Dedicated player page for that game |
| `/api/players` | JSON API for total/game player counts |
| `/ws` | WebSocket endpoint for multiplayer clients |
| `/easyrpg-player.html` | Standalone EasyRPG Player page |
| `/src/*`, `/styles/*`, `/games/*`, `*.wasm`, etc. | Frontend static assets |

Game routes are discovered automatically from the `frontend/games/` directory. Adding a new game folder makes its route available immediately (no backend code changes required).

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

## How to run
`node main`

# 🍎 Poly Apple - Backend

This is the Authoritative Server for **Poly Apple**. The backend is responsible for managing game rooms, tracking scores, determining the winner, and broadcasting real-time state synchronization to thousands of concurrent players.

## 🛠 Tech Stack & Versions

- **Core Runtime:** Node.js
- **Web Framework:** Express.js (`^4.18.2`) - Serves as the base routing framework and middleware handler.
- **CORS:** `cors` (`^2.8.6`) - Allows the separated Frontend (running on a different port or deployed on Vercel) to connect securely.
- **Real-time Engine:** Socket.io (`^4.6.1`) - Handles ultra-low latency, bidirectional communication via Websockets.

## 🚀 How to Run (Local Development)

1. Open a terminal in the `backend/` directory.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start the server (uses Nodemon for auto-reloading):
   ```bash
   npm run dev
   ```
   *(The server will run on `http://localhost:3000` by default)*

## 📂 File Structure

```text
backend/
├── server.js        # The main entry point containing all Server logic and Websocket handlers.
├── package.json     # Manages backend dependencies.
├── data/            # (Auto-generated) Acts as a local NoSQL Database.
│   ├── players.json # Stores player identities (UUID), names, and avatars.
│   ├── rooms.json   # Stores the state of active rooms (Waiting, Playing, Ended).
│   └── sessions.json# Stores match history, coordinates of eaten apples, and equations used.
└── README.md        # The documentation file you are currently reading.
```

## ⚙️ Core Functionality

- **NoSQL File-based System:** To avoid database bottlenecks during the MVP phase, the system uses in-memory `Map()` objects for blazing-fast operations, and periodically dumps data to JSON files in the `data/` folder via `fs.writeFileSync` (every 2 seconds) for persistence.
- **Room Management (`roomsDb`):** Handles lobby creation, 6-character random room codes, and triggers game start when both players are ready.
- **Authoritative State:** All critical events (eating an apple, scoring, ending the game) are validated and stored by the Server (`sessionDb`) to prevent client-side hacking. The server acts as the ultimate "Referee".
- **Garbage Collection (Cron Job):** Every 60 seconds, the server sweeps through memory and permanently deletes inactive/empty rooms that have expired (5-minute timeout) to prevent memory leaks.
- **Spectator Mode:** Allows clients to join and watch an ongoing game. The server dispatches a complete synchronization payload (`eatenApples`, `elapsedTime`, `history`) to the spectator so they can view the live state immediately.

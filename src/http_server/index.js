import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import { WebSocketServer } from "ws";

const users = [];
const rooms = [];

let nextRoomId = 1;

function getShipPositions(ship) {
  const positions = [];
  for (let i = 0; i < ship.length; i++) {
    positions.push({
      x: ship.direction ? ship.position.x : ship.position.x + i,
      y: ship.direction ? ship.position.y + i : ship.position.y,
    });
  }
  return positions;
}

function isShipKilled(ship, allHits) {
  const positions = getShipPositions(ship);
  return positions.every((pos) =>
    allHits.some((hit) => hit.x === pos.x && hit.y === pos.y)
  );
}

export const httpServer = http.createServer(function (req, res) {
  const __dirname = path.resolve(path.dirname(""));
  const file_path =
    __dirname + (req.url === "/" ? "/front/index.html" : "/front" + req.url);
  fs.readFile(file_path, function (err, data) {
    if (err) {
      res.writeHead(404);
      res.end(JSON.stringify(err));
      return;
    }
    res.writeHead(200);
    res.end(data);
  });
});

export const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
  console.log("New client connected");

  ws.on("message", (message) => {
    console.log("Message received:", message.toString());

    let parsed;
    try {
      parsed = JSON.parse(message);
    } catch (e) {
      console.error("Invalid JSON format:", message);
      return;
    }

    if (parsed.type === "reg") {
      let name, password;

      try {
        const data =
          typeof parsed.data === "string"
            ? JSON.parse(parsed.data)
            : parsed.data;

        name = data.name;
        password = data.password;
      } catch (e) {
        console.error("Invalid data format:", parsed.data);
        return;
      }

      const existingUser = users.find((u) => u.name === name);

      if (existingUser) {
        if (existingUser.password !== password) {
          return ws.send(
            JSON.stringify({
              type: "reg",
              data: {
                name,
                index: null,
                error: true,
                errorText: "Wrong password",
              },
              id: 0,
            })
          );
        }
      } else {
        users.push({ name, password, wins: 0 });
      }

      ws.send(
        JSON.stringify({
          type: "reg",
          data: JSON.stringify({
            name,
            index: name,
            error: false,
            errorText: "",
          }),
          id: 0,
        })
      );
      ws.username = name;
      const winners = {
        type: "update_winners",
        data: JSON.stringify(
          users.map((u) => ({
            name: u.name,
            wins: u.wins,
          }))
        ),
        id: 0,
      };

      wss.clients.forEach((client) => {
        if (client.readyState === 1) {
          client.send(JSON.stringify(winners));
        }
      });
    }

    if (parsed.type === "create_room") {
      const roomId = nextRoomId++;
      const playerName = ws.username;
      const playerIndex = ws.username;

      const room = {
        roomId,
        roomUsers: [{ name: playerName, index: playerIndex }],
      };
      rooms.push(room);

      const data = {
        type: "update_room",
        data: JSON.stringify(
          rooms.filter((room) => room.roomUsers.length === 1)
        ),
        id: 0,
      };

      const str = JSON.stringify(data);
      wss.clients.forEach((client) => {
        if (client.readyState === 1) {
          client.send(str);
        }
      });
    }

    if (parsed.type === "add_user_to_room") {
      const data =
        typeof parsed.data === "string" ? JSON.parse(parsed.data) : parsed.data;

      const room = rooms.find((r) => r.roomId === data.indexRoom);

      if (!room) {
        console.error("Комната не найдена:", data.indexRoom);
        return;
      }

      if (room.roomUsers.length >= 2) {
        console.error("Комната уже полная:", data.indexRoom);
        return;
      }

      const secondPlayer = {
        name: ws.username,
        index: ws.username,
      };

      room.roomUsers.push(secondPlayer);

      room.roomUsers.forEach((player) => {
        const target = [...wss.clients].find((c) => c.username === player.name);
        if (target && target.readyState === 1) {
          target.send(
            JSON.stringify({
              type: "create_game",
              data: JSON.stringify({
                idGame: room.roomId,
                idPlayer: player.index,
              }),
              id: 0,
            })
          );
        }
      });

      const openRooms = rooms.filter((r) => r.roomUsers.length === 1);
      wss.clients.forEach((client) => {
        if (client.readyState === 1) {
          client.send(
            JSON.stringify({
              type: "update_room",
              data: JSON.stringify(openRooms),
              id: 0,
            })
          );
        }
      });
    }

    if (parsed.type === "add_ships") {
      const data =
        typeof parsed.data === "string" ? JSON.parse(parsed.data) : parsed.data;
      const { gameId, ships, indexPlayer } = data;

      const room = rooms.find((r) => r.roomId === Number(gameId));
      if (!room) return console.error("Room not found:", gameId);

      room.ships = room.ships || {};
      room.hits = room.hits || {};
      room.killed = room.killed || {};

      room.ships[indexPlayer] = ships;

      const bothReady = room.roomUsers.every(
        (player) => room.ships[player.index]
      );

      if (bothReady) {
        const current = room.roomUsers[Math.floor(Math.random() * 2)].index;
        room.currentTurn = current;

        room.roomUsers.forEach((player) => {
          const target = [...wss.clients].find(
            (c) => c.username === player.name
          );
          if (target && target.readyState === 1) {
            target.send(
              JSON.stringify({
                type: "start_game",
                data: JSON.stringify({
                  ships: room.ships[player.index],
                  currentPlayerIndex: current,
                }),
                id: 0,
              })
            );
          }
        });

        console.log(`Game ${gameId} started. First move: ${current}`);
      }
    }

    if (parsed.type === "attack") {
      const data =
        typeof parsed.data === "string" ? JSON.parse(parsed.data) : parsed.data;
      const { gameId, x, y, indexPlayer } = data;

      const room = rooms.find((r) => r.roomId === Number(gameId));
      if (!room) return console.error("❌ Room not found");

      if (room.currentTurn !== indexPlayer)
        return console.warn("Not player's turn");

      const enemy = room.roomUsers.find((p) => p.index !== indexPlayer);
      if (!enemy) return console.error("Enemy not found");

      room.hits = room.hits || {};
      room.killed = room.killed || {};
      room.hits[indexPlayer] = room.hits[indexPlayer] || [];
      room.killed[indexPlayer] = room.killed[indexPlayer] || [];

      const alreadyHit = room.hits[indexPlayer].some(
        (h) => h.x === x && h.y === y
      );
      if (alreadyHit) return console.warn("Already attacked");

      room.hits[indexPlayer].push({ x, y });

      const enemyShips = room.ships[enemy.index];
      let status = "miss";
      let hitShip = null;

      for (const ship of enemyShips) {
        const positions = getShipPositions(ship);
        const hit = positions.some((p) => p.x === x && p.y === y);
        if (hit) {
          status = "shot";
          hitShip = ship;

          if (isShipKilled(ship, room.hits[indexPlayer])) {
            status = "killed";
            const killedCells = getShipPositions(ship);
            room.killed[indexPlayer].push(...killedCells);

            killedCells.forEach((cell) => {
              const killMsg = {
                type: "attack",
                data: JSON.stringify({
                  position: cell,
                  currentPlayer: indexPlayer,
                  status: "killed",
                }),
                id: 0,
              };
              const killStr = JSON.stringify(killMsg);
              wss.clients.forEach((client) => {
                if (client.readyState === 1) client.send(killStr);
              });
            });
          }
          if (status !== "killed") {
            const response = {
              type: "attack",
              data: JSON.stringify({
                position: { x, y },
                currentPlayer: indexPlayer,
                status: status,
              }),
              id: 0,
            };
            const str = JSON.stringify(response);
            wss.clients.forEach((client) => {
              if (client.readyState === 1) client.send(str);
            });
          }

          break;
        }
      }

      const response = {
        type: "attack",
        data: JSON.stringify({
          position: { x, y },
          currentPlayer: indexPlayer,
          status: status,
        }),
        id: 0,
      };

      const str = JSON.stringify(response);
      wss.clients.forEach((client) => {
        if (client.readyState === 1) client.send(str);
      });

      if (status === "miss") {
        room.currentTurn = enemy.index;
        const turnUpdate = {
          type: "turn",
          data: JSON.stringify({ currentPlayer: room.currentTurn }),
          id: 0,
        };

        const turnStr = JSON.stringify(turnUpdate);
        wss.clients.forEach((client) => {
          if (client.readyState === 1) client.send(turnStr);
        });
      }

      const allEnemyCells = enemyShips.flatMap(getShipPositions);
      const killed = room.killed[indexPlayer].map((p) => `${p.x},${p.y}`);
      const won = allEnemyCells.every((p) => killed.includes(`${p.x},${p.y}`));

      if (won) {
        const winMsg = {
          type: "finish",
          data: JSON.stringify({ winPlayer: indexPlayer }),
          id: 0,
        };
        const winStr = JSON.stringify(winMsg);
        wss.clients.forEach((client) => {
          if (client.readyState === 1) client.send(winStr);
        });

        const user = users.find((u) => u.name === indexPlayer);
        if (user) user.wins++;

        const updateWinners = {
          type: "update_winners",
          data: JSON.stringify(
            users.map((u) => ({ name: u.name, wins: u.wins }))
          ),
          id: 0,
        };
        const winnersStr = JSON.stringify(updateWinners);
        wss.clients.forEach((client) => {
          if (client.readyState === 1) client.send(winnersStr);
        });
      }
    }
    if (parsed.type === "randomAttack") {
      const data =
        typeof parsed.data === "string" ? JSON.parse(parsed.data) : parsed.data;
      const { gameId, indexPlayer } = data;

      const room = rooms.find((r) => r.roomId === Number(gameId));
      if (!room) return console.error("room not found for randomAttack");

      const enemy = room.roomUsers.find((p) => p.index !== indexPlayer);
      if (!enemy) return console.error("enemy not found");

      const alreadyHit = room.hits[indexPlayer] || [];
      const tried = new Set(alreadyHit.map((h) => `${h.x},${h.y}`));

      let x = -1,
        y = -1,
        attempts = 0;
      do {
        x = Math.floor(Math.random() * 10);
        y = Math.floor(Math.random() * 10);
        attempts++;
        if (attempts > 100)
          return console.error("Too many attempts to find free cell");
      } while (tried.has(`${x},${y}`));

      const fakeAttack = {
        type: "attack",
        data: JSON.stringify({ gameId, x, y, indexPlayer }),
        id: 0,
      };

      ws.emit("message", JSON.stringify(fakeAttack));
    }

    if (parsed.type === "add_ships") {
      const data =
        typeof parsed.data === "string" ? JSON.parse(parsed.data) : parsed.data;
      const { gameId, ships, indexPlayer } = data;

      const room = rooms.find((r) => r.roomId === Number(gameId));
      if (!room) return console.error("Room not found:", gameId);

      room.ships = room.ships || {};
      room.hits = room.hits || {};
      room.killed = room.killed || {};

      room.ships[indexPlayer] = ships;

      const bothReady = room.roomUsers.every(
        (player) =>
          Array.isArray(room.ships[player.index]) &&
          room.ships[player.index].length > 0
      );

      if (bothReady) {
        const current = room.roomUsers[Math.floor(Math.random() * 2)].index;
        room.currentTurn = current;

        room.roomUsers.forEach((player) => {
          const client = [...wss.clients].find(
            (c) => c.username === player.name
          );
          if (client && client.readyState === 1) {
            client.send(
              JSON.stringify({
                type: "start_game",
                data: JSON.stringify({
                  ships: room.ships[player.index],
                  currentPlayerIndex: current,
                }),
                id: 0,
              })
            );
          }
        });

        console.log(`Game ${gameId} started. First turn: ${current}`);

        if (current === "Bot") {
          const fakeBotMove = {
            type: "randomAttack",
            data: JSON.stringify({ gameId, indexPlayer: "Bot" }),
            id: 0,
          };
          ws.emit("message", JSON.stringify(fakeBotMove));
        }
      }
    }

    if (parsed.type === "single_play") {
      const username = ws.username;
      if (!username) return;

      let botUser = users.find((u) => u.name === "Bot");
      if (!botUser) {
        botUser = { name: "Bot", password: "123", wins: 0 };
        users.push(botUser);
      }

      const roomId = nextRoomId++;
      const room = {
        roomId,
        roomUsers: [
          { name: username, index: username },
          { name: "Bot", index: "Bot" },
        ],
      };
      rooms.push(room);

      room.roomUsers.forEach((player) => {
        const client =
          [...wss.clients].find((c) => c.username === player.name) || ws;
        if (client && client.readyState === 1) {
          client.send(
            JSON.stringify({
              type: "create_game",
              data: JSON.stringify({
                idGame: roomId,
                idPlayer: player.index,
              }),
              id: 0,
            })
          );
        }
      });

      console.log(`Single player game started: ${roomId}`);
    }
  });

  ws.on("close", () => {
    console.log("Client disconnected");
  });
});

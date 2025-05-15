import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import { WebSocketServer } from "ws";

const users = [];
const rooms = [];
let nextRoomId = 1;

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
              data: JSON.stringify({
                name,
                index: null,
                error: true,
                errorText: "Wrong password",
              }),
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
  });

  ws.on("close", () => {
    console.log("Client disconnected");
  });
});

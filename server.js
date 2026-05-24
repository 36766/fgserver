const WebSocket = require("ws")

const PORT = process.env.PORT || 10000

const server = new WebSocket.Server({ port: PORT })

let players = []

server.on("connection", socket => {
    console.log("Player connected")

    players.push(socket)

    const playerIndex = players.length - 1

    socket.send(JSON.stringify({
        type: "playerNumber",
        number: playerIndex
    }))

    socket.on("message", message => {
        for (const player of players) {
            if (player !== socket && player.readyState === WebSocket.OPEN) {
                player.send(message.toString())
            }
        }
    })

    socket.on("close", () => {
        console.log("Player disconnected")

        players = players.filter(p => p !== socket)
    })
})

console.log("Server running")
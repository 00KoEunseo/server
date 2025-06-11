import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// 방 정보 저장: roomId => { hostId, videoId, currentTime, isPlaying, skipCounts, skipUsers, users: Map<socketId, nickname> }
const rooms = new Map();

io.on("connection", (socket) => {
  console.log("✅ 연결됨:", socket.id);

  // 방 생성
socket.on("create_room", ({ roomId, videoId, password }) => {
  rooms.set(roomId, {
    hostId: socket.id,
    videoId,
    currentTime: 0,
    isPlaying: false,
    skipCounts: { forward: 0, backward: 0 },
    skipUsers: new Set(),
    users: new Map(), // ❌ join_room 이전에는 등록하지 않음
    password: password || null, // 비밀번호 저장 (없으면 null)
  });

  socket.join(roomId);
  socket.emit("room_created", { roomId });

  console.log(`🛠️ 방 생성됨: ${roomId}, 방장: ${socket.id}, 잠금: ${password ? "예" : "아니오"}`);
});


  // 방 참가
  socket.on("join_room", ({ roomId, nickname, password }) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit("error", { message: "존재하지 않는 방입니다." });
      return;
    }

    // 호스트는 비밀번호 검사 안함
    if (socket.id !== room.hostId && room.password) {
      if (password !== room.password) {
        socket.emit("error", { message: "비밀번호가 틀렸습니다." });
        return;
      }
    }

    socket.join(roomId);
    room.users.set(socket.id, nickname);
    const isHost = socket.id === room.hostId;

    socket.emit("room_data", {
      videoId: room.videoId,
      isHost,
      currentTime: room.currentTime,
      isPlaying: room.isPlaying,
      skipCounts: room.skipCounts,
      usersCount: room.users.size,
      userList: Array.from(room.users.values()),
      isLocked: !!room.password, // 잠금 여부 정보 전달
    });

    io.to(roomId).emit("user_list_update", Array.from(room.users.values()));

    console.log(`🚪 방 참가: ${roomId}, 사용자: ${socket.id}, 닉네임: ${nickname}`);
  });

// 방 기본 정보 요청
socket.on("get_room_info", ({ roomId }) => {
  const room = rooms.get(roomId);
  if (!room) {
    socket.emit("error", { message: "존재하지 않는 방입니다." });
    return;
  }

  socket.emit("room_info", {
    isLocked: !!room.password,
  });
});

  //방목록
 socket.on("get_room_list", ({ page = 1 }) => {
    const pageSize = 10;
    const roomEntries = Array.from(rooms.entries()).reverse();

    const paginated = roomEntries.slice((page - 1) * pageSize, page * pageSize);

    const roomList = paginated.map(([roomId, room]) => {
      const hostNickname = room.users.get(room.hostId) || "알 수 없음";
      return {
        roomId,
        displayName: `${hostNickname} : ${roomId}`,
        isLocked: !!room.password,
      };
    });

    socket.emit("room_list", {
      rooms: roomList,
      hasNextPage: page * pageSize < rooms.size,
    });
  });

  // 반장이 주기적으로 보내는 현재 시간 업데이트 처리
  socket.on("host_current_time_update", ({ roomId, currentTime }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    if (socket.id !== room.hostId) return;

    room.currentTime = currentTime;
  });

  // 방장의 재생 이벤트
  socket.on("video_play", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || socket.id !== room.hostId) return;

    room.isPlaying = true;
    socket.to(roomId).emit("video_play");
  });

  // 방장의 정지 이벤트
  socket.on("video_pause", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || socket.id !== room.hostId) return;

    room.isPlaying = false;
    socket.to(roomId).emit("video_pause");
  });

  // 방장의 탐색 이벤트
  socket.on("video_seek", ({ roomId, time }) => {
    const room = rooms.get(roomId);
    if (!room || socket.id !== room.hostId) return;

    room.currentTime = time;
    socket.to(roomId).emit("video_seek", { time });
  });

  // 방장의 영상 변경 이벤트
  socket.on("change_video", ({ roomId, newVideoId }) => {
    const room = rooms.get(roomId);
    if (!room || socket.id !== room.hostId) return;

    room.videoId = newVideoId;
    room.currentTime = 0;
    room.isPlaying = false;
    room.skipCounts = { forward: 0, backward: 0 };
    room.skipUsers.clear();

    io.to(roomId).emit("video_changed", {
      videoId: newVideoId,
      currentTime: 0,
      isPlaying: false,
      skipCounts: room.skipCounts,
    });

    console.log(`🎬 방 ${roomId} 영상 변경: ${newVideoId} by ${socket.id}`);
  });

  // 스킵 요청 이벤트 (forward/backward)
  socket.on("skip_request", ({ roomId, direction }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    if (room.skipUsers.has(socket.id)) return;

    room.skipUsers.add(socket.id);
    room.skipCounts[direction] = (room.skipCounts[direction] || 0) + 1;

    const roomSize = room.users.size;

    if (room.skipCounts[direction] >= roomSize / 2) {
      // 과반수 충족 → 현재 room.currentTime 사용
      const skipSeconds = direction === "forward" ? 10 : -10;
      room.currentTime = Math.max(room.currentTime + skipSeconds, 0);

      room.skipCounts = { forward: 0, backward: 0 };
      room.skipUsers.clear();

      io.to(roomId).emit("video_seek", { time: room.currentTime });
      io.to(roomId).emit("skip_counts_update", room.skipCounts);
      console.log(`⏩ 과반수 스킵 실행: ${roomId}, ${room.currentTime}초`);
    } else {
      io.to(roomId).emit("skip_counts_update", room.skipCounts);
    }

    setTimeout(() => {
      room.skipUsers.delete(socket.id);
      room.skipCounts[direction] = Math.max(room.skipCounts[direction] - 1, 0);
      io.to(roomId).emit("skip_counts_update", room.skipCounts);
    }, 2000);
  });

  // 연결 해제시 사용자 목록에서 제거 및 알림
  socket.on("disconnect", () => {
    console.log("❌ 연결 종료:", socket.id);
    for (const [roomId, room] of rooms) {
      if (room.users.has(socket.id)) {
        room.users.delete(socket.id);

        if (room.hostId === socket.id) {
          // 호스트가 나간 경우 방 삭제
          rooms.delete(roomId);
          io.to(roomId).emit("room_closed"); // 클라이언트에 방 종료 알림
          io.socketsLeave(roomId); // 모두 방에서 나가게 함
          console.log(`🧹 방 삭제됨: ${roomId} (호스트 나감)`);
        } else {
          // 호스트가 아닌 경우 사용자 목록 업데이트만
          io.to(roomId).emit("user_list_update", Array.from(room.users.values()));
        }
        break;
      }
    }
  });

  socket.on("chat_message", ({ roomId, message }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    const nickname = room.users.get(socket.id) || "익명";
    // 메시지 최대 10자 제한
    const truncatedMsg = message.length > 10 ? message.slice(0, 10) + "…" : message;

    // 모든 참여자에게 채팅 메시지 전송
    io.to(roomId).emit("chat_message", { nickname, message: truncatedMsg });
  });
  
});

server.listen(4000, () => {
  console.log("🚀 서버 실행 중!!!");
});

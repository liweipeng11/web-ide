const [operation = "exit", rawValue = "0"] = process.argv.slice(2);
const value = Number.parseInt(rawValue, 10);

// 该夹具只使用本地标准输入输出和定时器，避免测试依赖网络或真实开发服务器。
switch (operation) {
  case "exit":
    process.exit(Number.isFinite(value) ? value : 0);
    break;
  case "output":
    for (let index = 0; index < value; index += 1) console.log(`line-${index}`);
    break;
  case "sleep":
    setTimeout(() => process.exit(0), value);
    break;
  case "server":
    // 使用真实本地监听验证 stop 会释放整个进程树，而不是只停止外层 shell。
    http.createServer((_request, response) => response.end("ready")).listen(value, "127.0.0.1", () => {
      console.log(`ready at http://localhost:${value}`);
    });
    break;
  case "silent-server":
    setInterval(() => undefined, 1_000);
    break;
  case "spam":
    for (let index = 0; index < value; index += 1) console.log(`spam-${index.toString().padStart(6, "0")}`);
    break;
  default:
    console.error(`Unknown fixture operation: ${operation}`);
    process.exit(2);
}
import http from "node:http";

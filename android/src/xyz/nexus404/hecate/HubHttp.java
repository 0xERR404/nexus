package xyz.nexus404.hecate;

import java.io.*;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONObject;

/** A request belongs to one Android job; stopping another job cannot cancel it. */
final class HubHttp {
  static final class Result {
    final int code;
    final JSONObject body;

    Result(int code, JSONObject body) {
      this.code = code;
      this.body = body;
    }

    boolean acknowledged() {
      String state = body.optString("state");
      return code == 200
          && (state.equals("accepted")
              || state.equals("pending")
              || state.equals("ignored")
              || state.equals("dismissed"));
    }
  }

  static final class Call {
    volatile boolean stopped;
    volatile int responseCode;
    private volatile HttpsURLConnection connection;

    void cancel() {
      stopped = true;
      HttpsURLConnection current = connection;
      if (current != null) new Thread(current::disconnect, "hub-cancel").start();
    }

    Result post(JSONObject cfg, String route, JSONObject body) throws Exception {
      responseCode = 0;
      if (stopped) throw new InterruptedException();
      URL url = new URL(cfg.getString("origin") + route);
      if (!url.getProtocol().equals("https")) throw new IOException("Нужен HTTPS");
      HttpsURLConnection current = (HttpsURLConnection) url.openConnection();
      connection = current;
      try {
        current.setInstanceFollowRedirects(false);
        current.setConnectTimeout(10000);
        current.setReadTimeout(15000);
        current.setRequestMethod("POST");
        current.setDoOutput(true);
        current.setRequestProperty("Authorization", "Bearer " + cfg.getString("token"));
        current.setRequestProperty("Content-Type", "application/json");
        byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
        if (bytes.length > 1800000) throw new IOException("Пакет превышает лимит хаба");
        current.setFixedLengthStreamingMode(bytes.length);
        if (stopped) throw new InterruptedException();
        try (OutputStream out = current.getOutputStream()) {
          out.write(bytes);
        }
        int code = current.getResponseCode();
        responseCode = code;
        JSONObject result = new JSONObject();
        if (code == 200) {
          try (InputStream in = current.getInputStream();
              ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];
            int count;
            while ((count = in.read(buffer)) != -1) {
              if (stopped) throw new InterruptedException();
              if (out.size() + count > 65536) throw new IOException("Ответ хаба слишком большой");
              out.write(buffer, 0, count);
            }
            result = new JSONObject(out.toString("UTF-8"));
          }
        }
        if (stopped) throw new InterruptedException();
        return new Result(code, result);
      } finally {
        connection = null;
        current.disconnect();
      }
    }

    JSONObject send(JSONObject cfg, JSONObject body) throws Exception {
      Result result = post(cfg, "/api/rhythm/sync", body);
      if (result.code != 200)
        throw new IOException(
            result.code == 401
                ? "Ключ Асклепия отозван или неверен"
                : result.code == 429
                    ? "Лимит приёмника · повтор будет позже"
                    : "Хаб отклонил пакет (HTTP " + result.code + ")");
      return result.body;
    }
  }
}

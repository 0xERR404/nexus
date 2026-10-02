package xyz.nexus404.hecate;

import java.nio.*;
import java.util.*;
import org.json.*;

final class BandDetails {
  static long uint(ByteBuffer b) {
    return b.getInt() & 0xffffffffL;
  }

  static void require(boolean ok, String reason) {
    if (!ok) throw new IllegalArgumentException(reason);
  }

  static byte[] take(ByteBuffer b, int n) {
    require(n >= 0 && n <= b.remaining(), "Обрезанный файл истории");
    byte[] a = new byte[n];
    b.get(a);
    return a;
  }

  static JSONArray stress(byte[] file, BandHistory h) throws Exception {
    require(file.length >= 48 && (file.length - 48) % 66 == 0, "Неверная длина RRI");
    ByteBuffer b = ByteBuffer.wrap(file);
    long declared = b.getLong();
    b.getShort();
    int version = b.getShort() & 65535;
    require(declared == file.length && version == 3, "Неизвестный формат RRI");
    b.position(48);
    JSONArray out = new JSONArray();
    while (b.hasRemaining()) {
      long start = uint(b) * 1000, end = uint(b) * 1000;
      byte[] payload = take(b, 58);
      int value = payload[4] & 255;
      if (start < 946684800000L
          || end <= start
          || end > h.until
          || end - start > 86400000L
          || value < 1
          || value > 100) continue;
      JSONObject row = h.record("stress", start, end).put("value", value);
      if (h.metricsEnabled)
        row.put("deviceFields", new JSONObject().put("rriV3", BandAuth.hex(payload)));
      out.put(row);
    }
    return out;
  }

  static Map<Long, Double> summary(byte[] bytes) {
    Map<Long, Double> values = new HashMap<>();
    collect(bytes, 0, values);
    return values;
  }

  static void collect(byte[] bytes, int depth, Map<Long, Double> values) {
    require(depth <= 3, "Вложенность сводки сна");
    ByteBuffer b = ByteBuffer.wrap(bytes);
    while (b.hasRemaining()) {
      int tag = b.get() & 255, n = 0, k = 0, v;
      do {
        require(b.hasRemaining() && ++k <= 3, "Длина TLV сна");
        v = b.get() & 255;
        n = (n << 7) | (v & 127);
      } while ((v & 128) != 0);
      byte[] body = take(b, n);
      if ((tag & 128) != 0) {
        Map<Integer, byte[]> f;
        try {
          f = BandProtocol.parseTlv(body);
        } catch (IllegalArgumentException e) {
          collect(body, depth + 1, values);
          continue;
        }
        if (f.containsKey(3) && f.containsKey(4) && f.containsKey(5)) {
          long id = BandHistory.uint(f.get(3), 4);
          byte[] type = f.get(4), data = f.get(5);
          require(
              type.length > 0 && type.length <= 4 && data.length > 0 && data.length <= 8,
              "Неверное поле сводки сна");
          long t = 0, value = 0;
          for (byte x : type) t = (t << 8) | (x & 255);
          for (byte x : data) value = (value << 8) | (x & 255);
          double numeric = value;
          if (t == 6) {
            require(data.length == 8, "Неверное число сна");
            double d = Double.longBitsToDouble(value);
            if (!Double.isFinite(d) || d < 0 || d > Long.MAX_VALUE) continue;
            numeric = d;
          } else if (t != 1 && t != 2 && t != 3 && t != 4) continue;
          if (value == 0xbf800000L) continue;
          require(!values.containsKey(id), "Повтор поля сводки сна");
          values.put(id, numeric);
        } else collect(body, depth + 1, values);
      }
    }
  }

  static JSONArray sleep(byte[] file, BandHistory h, boolean bedTime) throws Exception {
    require(file.length >= 32, "Короткий файл сна");
    ByteBuffer b = ByteBuffer.wrap(file);
    long declared = uint(b), dictionary = uint(b);
    int fileType = b.getShort() & 65535;
    b.getShort();
    b.position(32);
    require(
        dictionary == 700013 && fileType != 2 && declared <= file.length,
        "Неизвестный словарь сна");
    JSONArray out = new JSONArray();
    int entries = 0;
    while (b.hasRemaining()) {
      require(b.remaining() >= 32 && ++entries <= 128, "Неверное число сессий сна");
      long fileStart = uint(b), fileEnd = uint(b);
      int version = b.get() & 255,
          summaryType = b.get() & 255,
          summaryLength = b.getShort() & 65535;
      long detailsLength = uint(b);
      b.position(b.position() + 16);
      byte[] summary = take(b, summaryLength);
      require(detailsLength <= b.remaining(), "Обрезанные стадии сна");
      byte[] details = take(b, (int) detailsLength);
      require(version == 1 && summaryType == 2, "Неизвестная версия подробного сна");
      Map<Long, Double> values = summary(summary);
      long start =
          values
              .getOrDefault(
                  bedTime && values.containsKey(700013786L) ? 700013298L : 700013686L, -1d)
              .longValue();
      long end = values.getOrDefault(700013156L, (double) fileEnd).longValue();
      require(
          start >= 946684800L && end > start && end - start <= 86400 && fileEnd >= fileStart,
          "Неверное время подробного сна");
      start = start / 60 * 60000L;
      end *= 1000L;
      if (end > h.until) continue;
      require(details.length % 8 == 0 && details.length / 8 <= 2000, "Неверная длина стадий сна");
      ByteBuffer d = ByteBuffer.wrap(details).order(ByteOrder.LITTLE_ENDIAN);
      long at = start;
      JSONArray stages = new JSONArray();
      boolean known = true;
      while (d.hasRemaining()) {
        long seconds = uint(d);
        int raw = d.get() & 255;
        d.position(d.position() + 3);
        require(
            seconds > 0 && seconds <= 86400 && seconds % 60 == 0,
            "Неверная длительность стадии сна");
        long next = at + seconds * 1000;
        require(next <= end + 60000, "Стадии выходят за границы сна");
        int stage = raw == 1 ? 4 : raw == 2 ? 6 : raw == 3 ? 5 : raw == 4 ? 1 : raw == 5 ? 2 : 0;
        if (stage == 0) known = false;
        stages.put(new JSONObject().put("start", at).put("end", next).put("stage", stage));
        at = next;
      }
      if (stages.length() == 0) continue;
      boolean complete = known && Math.abs(at - end) <= 60000 && end <= h.until - 2 * 3600000L;
      JSONObject record =
          h.record("sleep", start, at)
              .put("id", "band:" + h.device + ":trusleep:" + start)
              .put("complete", complete)
              .put("stages", stages)
              .put("detail", "trusleep");
      if (h.metricsEnabled) {
        record.put("metrics", sleepMetrics(values));
        JSONObject dictionaryFields = new JSONObject();
        for (Map.Entry<Long, Double> item : values.entrySet())
          if (item.getKey() >= 700013000L
              && item.getKey() <= 700013999L
              && item.getValue() >= 0
              && item.getValue() <= 9007199254740991d
              && dictionaryFields.length() < 128)
            dictionaryFields.put(String.valueOf(item.getKey()), item.getValue());
        record.put("dictionary", dictionaryFields);
      }
      out.put(record);
    }
    return out;
  }

  static JSONObject sleepMetrics(Map<Long, Double> values) throws Exception {
    long[] ids = {
      700013245, 700013232, 700013713, 700013635, 700013670, 700013436, 700013502, 700013580,
      700013340, 700013026, 700013468, 700013646, 700013492, 700013886, 700013878, 700013305,
      700013355, 700013759, 700013254, 700013721
    };
    String[] names = {
      "score",
      "efficiency",
      "latency",
      "wakeCount",
      "turnOverCount",
      "heartMin",
      "heartMax",
      "heartAverage",
      "oxygenMin",
      "oxygenMax",
      "oxygenAverage",
      "breathMin",
      "breathMax",
      "breathAverage",
      "hrvAverage",
      "hrvBaselineMin",
      "hrvBaselineMax",
      "rdi",
      "quality",
      "snoreFrequency"
    };
    double[] limits = {
      100, 100, 86400, 10000, 10000, 255, 255, 255, 100, 100, 100, 80, 80, 80, 200, 200, 200, 100,
      100000, 100000
    };
    JSONObject out = new JSONObject();
    for (int i = 0; i < ids.length; i++) {
      Double value = values.get(ids[i]);
      if (value != null && Double.isFinite(value) && value >= 0 && value <= limits[i])
        out.put(names[i], value);
    }
    return out;
  }
}

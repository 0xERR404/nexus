package xyz.nexus404.hecate;

import java.nio.*;
import java.util.*;
import org.json.*;

final class BandWorkout {
  static JSONObject page(Map<Integer, byte[]> tags, BandHistory h, int workout, int page)
      throws Exception {
    byte[] body = tags.get(129);
    BandDetails.require(body != null, "Нет страницы тренировки");
    BandDetails.require(
        BandHistory.uint(BandHistory.one(body, 2), 2) == workout
            && BandHistory.uint(BandHistory.one(body, 3), 2) == page,
        "Номер страницы тренировки не совпал");
    byte[] header = BandHistory.one(body, 4), data = BandHistory.one(body, 5);
    BandDetails.require(header.length == 14, "Длина заголовка тренировки");
    ByteBuffer b = ByteBuffer.wrap(header);
    int wid = b.getShort() & 65535, pid = b.getShort() & 65535;
    long start = BandDetails.uint(b) * 1000;
    int interval = b.get() & 255,
        count = b.getShort() & 65535,
        length = b.get() & 255,
        mask = b.getShort() & 65535;
    BandDetails.require(
        wid == workout
            && pid == page
            && count > 0
            && count <= 512
            && length > 0
            && count * length == data.length
            && interval > 0
            && (mask & ~1023) == 0,
        "Неизвестный формат страницы тренировки");
    Map<Integer, byte[]> fields = BandProtocol.parseTlv(body);
    int inner = fields.containsKey(8) ? BandProtocol.number(fields, 8) : 0;
    int[] sizes = {1, 2, 1, 2, 2, 4, inner, 2, 2, 2};
    int expected = 0;
    for (int i = 0; i < sizes.length; i++) if ((mask & (1 << i)) != 0) expected += sizes[i];
    BandDetails.require(
        inner >= 0 && inner <= 255 && expected == length, "Неизвестная длина отсчёта тренировки");
    long end = start + Math.max(1, count * interval) * 1000L;
    BandDetails.require(
        start >= 946684800000L && end <= h.until && end - start <= 86400000L,
        "Время страницы тренировки");
    ByteBuffer d = ByteBuffer.wrap(data);
    JSONArray samples = new JSONArray();
    for (int n = 0; n < count; n++) {
      JSONObject sample = new JSONObject().put("time", start + n * interval * 1000L);
      for (int i = 0; i < sizes.length; i++)
        if ((mask & (1 << i)) != 0) {
          if (i == 6) {
            byte[] raw = BandDetails.take(d, inner);
            sample.put("extensions", BandAuth.hex(raw));
            continue;
          }
          long v =
              sizes[i] == 1 ? d.get() & 255 : sizes[i] == 2 ? d.getShort() & 65535 : d.getInt();
          if (i == 0) {
            if (v >= 20 && v < 255) sample.put("heart", v);
          } else if (i == 1) {
            if (v < 65535) sample.put("speed", v / 10.0);
          } else if (i == 2) {
            if (v < 255) sample.put("cadence", v);
          } else if (i == 5) {
            if (v >= -12000 && v <= 100000) sample.put("altitude", v);
          } else if (v < 65535)
            sample.put(
                new String[] {
                      "heart",
                      "speed",
                      "cadence",
                      "swolf",
                      "strokeRate",
                      "altitude",
                      "extensions",
                      "calories",
                      "frequency",
                      "power"
                    }
                    [i],
                v);
        }
      samples.put(sample);
    }
    return h.record("sport", start, end)
        .put("id", "band:" + h.device + ":sport:" + workout + ":" + start + ":" + page)
        .put("workout", workout)
        .put("extensionMask", fields.containsKey(9) ? BandProtocol.number(fields, 9) : 0)
        .put("samples", samples);
  }
}

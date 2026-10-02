package xyz.nexus404.hecate;

import java.nio.ByteBuffer;
import java.util.*;
import org.json.*;

final class BandHistory {
  final long from, until, modified;
  final String device, source;
  boolean metricsEnabled;
  int kind, page, count;
  boolean finished;
  int unknownSleep;

  BandHistory(String device, long from, long until) {
    this.device = device;
    this.source = "Huawei Band 11 · " + device;
    this.from = from;
    this.until = until;
    modified = until;
  }

  static byte[] integer(long n) {
    return ByteBuffer.allocate(4).putInt((int) n).array();
  }

  BandAuth.Request begin() {
    kind = 0;
    return countRequest();
  }

  BandAuth.Request countRequest() {
    page = 0;
    count = -1;
    return new BandAuth.Request(
        7,
        kind == 0 ? 10 : 12,
        BandAuth.tlv(
            129,
            new byte[0],
            3,
            integer((kind == 0 ? from : Math.min(from, until - 2 * 86400000L)) / 1000),
            4,
            integer(until / 1000)),
        "История " + (kind == 0 ? "шагов / пульса / SpO₂" : "сна") + " · число страниц");
  }

  BandAuth.Request nextKind() {
    if (kind == 0) {
      kind = 1;
      return countRequest();
    }
    finished = true;
    return null;
  }

  BandAuth.Request pageRequest() {
    return new BandAuth.Request(
        7,
        kind == 0 ? 11 : 13,
        BandAuth.tlv(129, BandAuth.tlv(2, new byte[] {(byte) (page >> 8), (byte) page})),
        "История " + (kind == 0 ? "измерений" : "сна") + " · " + (page + 1) + "/" + count);
  }

  static long uint(byte[] a, int length) {
    if (a == null || a.length != length)
      throw new IllegalArgumentException("Неверная длина поля истории");
    long n = 0;
    for (byte b : a) n = (n << 8) | (b & 255);
    return n;
  }

  static byte[] one(byte[] body, int tag) {
    List<byte[]> values = BandProtocol.values(body, tag);
    if (values.size() != 1)
      throw new IllegalArgumentException("Нет уникального поля истории: " + tag);
    return values.get(0);
  }

  BandAuth.Request accept(Map<Integer, byte[]> fields, JSONArray records) throws Exception {
    byte[] body = fields.get(129);
    if (body == null) throw new IllegalArgumentException("Нет контейнера истории");
    int number = (int) uint(one(body, 2), 2);
    if (count == -1) {
      if (number > 512) throw new IllegalArgumentException("История превышает 512 страниц за окно");
      count = number;
      return count == 0 ? nextKind() : pageRequest();
    }
    if (number != page) throw new IllegalArgumentException("Номер страницы не совпал с запросом");
    if (kind == 0) activity(body, records);
    else sleep(body, records);
    page++;
    return page < count ? pageRequest() : nextKind();
  }

  JSONObject record(String type, long start, long end) throws Exception {
    return new JSONObject()
        .put("id", "band:" + device + ":" + type + ":" + start)
        .put("source", source)
        .put("type", type)
        .put("start", start)
        .put("end", end)
        .put("modified", modified);
  }

  void activity(byte[] body, JSONArray records) throws Exception {
    long base = uint(one(body, 3), 4) * 1000L;
    List<byte[]> entries = BandProtocol.values(body, 132);
    if (entries.size() > 512) throw new IllegalArgumentException("Слишком много отсчётов");
    for (byte[] entry : entries) {
      long start = base + uint(one(entry, 5), 1) * 60000L, end = start + 60000L;
      if (start < from || start >= until || end > until) continue;
      byte[] data = one(entry, 6);
      if (data.length == 0) throw new IllegalArgumentException("Нет маски измерений");
      int mask = data[0] & 255, mask2 = 0, p = 1;
      if ((mask & 128) != 0) {
        if (p >= data.length) throw new IllegalArgumentException("Нет второй маски");
        mask2 = data[p++] & 255;
      }
      int steps = -1, heart = -1, spo2 = -1, calories = -1, distance = -1;
      for (int bit = 1; bit < 128; bit <<= 1)
        if ((mask & bit) != 0) {
          int size = (bit == 32 || bit == 64) ? 1 : 2;
          if (p + size > data.length)
            throw new IllegalArgumentException("Обрезанная запись измерений");
          int value = data[p++] & 255;
          if (size == 2) value = (value << 8) | (data[p++] & 255);
          if (bit == 2) steps = value;
          if (bit == 4) calories = value;
          if (bit == 8) distance = value;
          if (bit == 64) heart = value;
        }
      for (int bit = 1; bit < 256; bit <<= 1)
        if ((mask2 & bit) != 0) {
          if (p >= data.length) throw new IllegalArgumentException("Обрезанная запись SpO₂");
          int value = data[p++] & 255;
          if (bit == 1) spo2 = value;
        }
      if (p != data.length) throw new IllegalArgumentException("Неизвестное расширение измерений");
      if (metricsEnabled) {
        JSONObject movement = new JSONObject();
        if (calories >= 0 && calories < 65535) movement.put("calories", calories);
        if (distance >= 0 && distance < 65535) movement.put("distance", distance);
        if (movement.length() > 0)
          records.put(record("movement", start, end).put("metrics", movement));
      }
      if (steps >= 0 && steps < 65535) records.put(record("steps", start, end).put("value", steps));
      if (heart >= 20 && heart < 255)
        records.put(
            record("heart", start, start + 1)
                .put(
                    "samples",
                    new JSONArray().put(new JSONObject().put("time", start).put("bpm", heart))));
      if (spo2 > 0 && spo2 <= 100) records.put(record("spo2", start, start + 1).put("value", spo2));
    }
  }

  void sleep(byte[] body, JSONArray records) throws Exception {
    List<byte[]> entries = BandProtocol.values(body, 131);
    if (entries.size() > 512) throw new IllegalArgumentException("Слишком много интервалов сна");
    for (byte[] entry : entries) {
      int raw = (int) uint(one(entry, 4), 1);
      byte[] time = one(entry, 5);
      if (time.length != 6) throw new IllegalArgumentException("Неверный интервал сна");
      long start = uint(Arrays.copyOf(time, 4), 4) * 1000L,
          end = start + uint(Arrays.copyOfRange(time, 4, 6), 2) * 60000L;
      if (end <= start || end - start > 7 * 86400000L)
        throw new IllegalArgumentException("Некорректная длительность сна");
      if (end < Math.min(from, until - 2 * 86400000L) || end > until || start < 946684800000L)
        continue;
      int stage = raw == 6 ? 4 : raw == 7 ? 5 : 0;
      if (stage == 0) unknownSleep++;
      records.put(
          record("sleep", start, end)
              .put("complete", false)
              .put(
                  "stages",
                  new JSONArray()
                      .put(
                          new JSONObject()
                              .put("start", start)
                              .put("end", end)
                              .put("stage", stage))));
    }
  }
}

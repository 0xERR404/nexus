package xyz.nexus404.hecate;

import java.nio.*;
import java.util.*;
import org.json.*;

/** Huawei 0A download: authenticated packets, bounded blocks, durable save before completion. */
final class BandLegacyFile {
  final BandFiles owner;
  int step, position, windowEnd, blockSize, sequence;
  byte[] content;
  boolean complete;

  BandLegacyFile(BandFiles owner) { this.owner = owner; }

  BandAuth.Request request(int command, byte[] fields, String label) {
    return owner.request(0x0a, command, fields, label + " · 0A/0" + command);
  }

  BandAuth.Request begin() {
    boolean sleep = owner.kind == 0;
    long end = owner.history.until / 1000;
    return request(1, BandAuth.tlv(2, new byte[] {(byte) (sleep ? 1 : 4)}, sleep ? 131 : 143,
        BandAuth.tlv(sleep ? 4 : 16, BandHistory.integer(end - (sleep ? 3 : 7) * 86400),
            sleep ? 5 : 17, BandHistory.integer(end))), "Запрос списка файлов " + (sleep ? "сна" : "стресса"));
  }

  BandAuth.Request accept(Map<Integer, byte[]> tags) throws Exception {
    BandAuth.checkResult(tags);
    if (step == 0) {
      byte[] names = BandAuth.required(tags, 1, 0, 4096);
      String list = new String(names, java.nio.charset.StandardCharsets.UTF_8);
      if (!Arrays.asList(list.split(";")).contains(owner.filename())) {
        owner.capabilitiesReport = "0A: запрошенный файл отсутствует в списке · " + owner.filename();
        return owner.next();
      }
      step = 1;
      return request(2, BandAuth.tlv(6, new byte[] {(byte) (owner.kind == 0 ? 1 : 4)}), "Параметры " + owner.filename());
    }
    if (step == 1) {
      int limit = (int) BandHistory.uint(tags.get(4), 2);
      if (limit < 1) throw new IllegalArgumentException("0A: нулевой размер блока");
      blockSize = Math.min(limit, 1024);
      step = 2;
      return request(3, BandAuth.tlv(1, BandAuth.utf(owner.filename())), "Размер " + owner.filename());
    }
    if (step == 2) {
      long length = BandHistory.uint(tags.get(2), 4);
      if (length > BandFiles.MAX_FILE) throw new IllegalArgumentException("0A: файл больше 1 МиБ");
      content = new byte[(int) length];
      return length == 0 ? finish() : block();
    }
    throw new IllegalArgumentException("0A: неожиданный ответ");
  }

  BandAuth.Request block() {
    step = 3;
    sequence = 0;
    windowEnd = Math.min(content.length, position + blockSize);
    return request(4, BandAuth.tlv(1, BandAuth.utf(owner.filename()), 2, BandHistory.integer(position),
        3, BandHistory.integer(windowEnd - position)), owner.filename() + " · " + position + "/" + content.length);
  }

  boolean receiving() { return step == 3 && !complete; }

  BandAuth.Request data(byte[] packet, byte[] key) throws Exception {
    if (!receiving()) throw new IllegalArgumentException("0A: блок вне передачи");
    // This protocol has no file-hash request; require GCM on every data packet.
    if (packet.length < 3 || packet[0] != 124 || packet[1] != 1 || packet[2] != 1)
      throw new java.security.GeneralSecurityException("0A: незашифрованные данные файла");
    byte[] raw = BandAuth.decryptedBytes(key, BandProtocol.parseTlv(packet));
    if (raw.length < 2 || (raw[0] & 255) != sequence || raw.length - 1 > windowEnd - position)
      throw new IllegalArgumentException("0A: нарушен номер или размер блока");
    System.arraycopy(raw, 1, content, position, raw.length - 1);
    position += raw.length - 1;
    sequence = (sequence + 1) & 255;
    if (position == content.length) return finish();
    return position == windowEnd ? block() : null;
  }

  BandAuth.Request finish() throws Exception {
    JSONArray parsed = content.length == 0 ? new JSONArray() : owner.kind == 0
        ? sleepState(content, owner.history) : BandDetails.stress(content, owner.history);
    if (owner.records.length() + parsed.length() > 10000) throw new IllegalArgumentException("0A: слишком много записей");
    for (int i = 0; i < parsed.length(); i++) owner.records.put(parsed.getJSONObject(i));
    complete = true;
    return request(6, BandAuth.tlv(6, new byte[] {1}), "Файл получен · записей: " + parsed.length());
  }

  static JSONArray sleepState(byte[] bytes, BandHistory history) throws Exception {
    if (bytes.length % 16 != 0 || bytes.length / 16 > 2000)
      throw new IllegalArgumentException("Неизвестный формат sleep_state.bin");
    JSONArray out = new JSONArray();
    ByteBuffer b = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
    while (b.hasRemaining()) {
      long start = (b.getInt() & 0xffffffffL) * 1000L, end = (b.getInt() & 0xffffffffL) * 1000L;
      byte[] unknown = new byte[8]; b.get(unknown);
      if (start == 0 && end == 0) continue;
      if (start < 946684800000L || end <= start || end - start > 7 * 86400000L)
        throw new IllegalArgumentException("Некорректный интервал sleep_state.bin");
      if (end > history.until || end < history.until - 3 * 86400000L) continue;
      JSONObject r = history.record("sleep", start, end)
          .put("id", "band:" + history.device + ":sleep-state:" + start)
          .put("complete", false)
          .put("stages", new JSONArray().put(new JSONObject().put("start", start).put("end", end).put("stage", 2)));
      if (history.metricsEnabled) r.put("deviceFields", new JSONObject().put("0a", BandAuth.hex(unknown)));
      out.put(r);
    }
    return out;
  }
}

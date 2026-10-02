package xyz.nexus404.hecate;

import java.util.*;

final class BandProtocol {
  static final UUID SERVICE = uuid("fe86"),
      WRITE = uuid("fe01"),
      READ = uuid("fe02"),
      CCC = uuid("2902");

  static UUID uuid(String shortId) {
    return UUID.fromString("0000" + shortId + "-0000-1000-8000-00805f9b34fb");
  }

  static int crc(byte[] data, int count) {
    int n = 0;
    for (int i = 0; i < count; i++) {
      n ^= (data[i] & 255) << 8;
      for (int bit = 0; bit < 8; bit++) n = ((n << 1) ^ ((n & 0x8000) != 0 ? 0x1021 : 0)) & 65535;
    }
    return n;
  }

  static byte[] query() {
    return frame(new byte[] {1, 0, 2, 0, 3, 0, 4, 0});
  }

  static byte[] frame(byte[] tlv) {
    return frame(1, tlv);
  }

  static byte[] frame(int command, byte[] tlv) {
    return frame(1, command, tlv);
  }

  static byte[] frame(int service, int command, byte[] tlv) {
    if (tlv.length > 2045) throw new IllegalArgumentException("Слишком длинный запрос");
    byte[] a = new byte[tlv.length + 8];
    a[0] = 0x5a;
    int len = tlv.length + 3;
    a[1] = (byte) (len >> 8);
    a[2] = (byte) len;
    a[4] = (byte) service;
    a[5] = (byte) command;
    System.arraycopy(tlv, 0, a, 6, tlv.length);
    int c = crc(a, a.length - 2);
    a[a.length - 2] = (byte) (c >> 8);
    a[a.length - 1] = (byte) c;
    return a;
  }

  static byte[] negotiation(byte[] identity) {
    if (identity.length != 32) throw new IllegalArgumentException("Неверная длина идентификатора");
    java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
    field(out, 1, new byte[] {4});
    field(out, 2, new byte[] {1});
    field(out, 5, identity);
    field(out, 3, new byte[] {1});
    field(out, 4, new byte[] {0});
    field(out, 6, new byte[0]);
    field(out, 7, "NEXUS404".getBytes(java.nio.charset.StandardCharsets.US_ASCII));
    return frame(0x33, out.toByteArray());
  }

  static void field(java.io.ByteArrayOutputStream out, int tag, byte[] value) {
    if (value.length > 8192) throw new IllegalArgumentException("Длинное поле");
    out.write(tag);
    if (value.length >= 128) out.write(0x80 | (value.length >> 7));
    out.write(value.length & 127);
    out.write(value, 0, value.length);
  }

  static int number(Map<Integer, byte[]> tags, int tag) {
    byte[] a = tags.get(tag);
    if (a == null || a.length != 1) return -1;
    return a[0] & 255;
  }

  static String negotiationReport(Map<Integer, byte[]> tags) {
    int mode = number(tags, 1), kind = number(tags, 2);
    StringBuilder s =
        new StringBuilder(
            "Ответ SecurityNegotiation\nРежим: " + mode + "\nВариант: " + kind + "\n");
    byte[] code = tags.get(127);
    if (code != null && code.length > 0 && code.length <= 4) {
      long n = 0;
      for (byte b : code) n = (n << 8) | (b & 255);
      s.append("Код результата: ").append(n).append('\n');
    }
    byte[] nonce = tags.get(3);
    s.append("Размер challenge: ").append(nonce == null ? 0 : nonce.length).append('\n');
    s.append("Кандидат протокола: ");
    if (mode == 4 && (kind == 1 || kind == 2)) s.append("HiChain3");
    else if (mode == 1 && kind < 0) s.append("HiChain");
    else if (mode != 4 && (kind == 1 || kind == 2)) s.append("HiChain Lite");
    else s.append("не определён");
    s.append("\nПоля:");
    for (int tag : tags.keySet()) s.append(' ').append(Integer.toHexString(tag));
    return s.toString();
  }

  interface Unsolicited {
    void accept(int service, int command, Map<Integer, byte[]> fields);
  }

  Unsolicited unsolicited;
  private int expectedService, expectedCommand;

  BandProtocol() {
    this(1);
  }

  BandProtocol(int command) {
    this(1, command);
  }

  BandProtocol(int service, int command) {
    expectedService = service;
    expectedCommand = command;
  }

  void expect(int service, int command) {
    expectedService = service;
    expectedCommand = command;
  }

  private byte[] pending = new byte[0], slices = null;
  private int sliceNumber;

  Map<Integer, byte[]> accept(byte[] part) {
    if (part == null) return null;
    if (pending.length + part.length > 4096)
      throw new IllegalArgumentException("Слишком длинный ответ");
    byte[] all = Arrays.copyOf(pending, pending.length + part.length);
    System.arraycopy(part, 0, all, pending.length, part.length);
    pending = all;
    while (pending.length >= 3) {
      if (pending[0] != 0x5a) throw new IllegalArgumentException("Неизвестный формат ответа");
      int length = ((pending[1] & 255) << 8) | (pending[2] & 255);
      if (length < 3 || length > 2048)
        throw new IllegalArgumentException("Некорректная длина ответа");
      int total = length + 5;
      if (pending.length < total) return null;
      byte[] a = Arrays.copyOf(pending, total);
      pending = Arrays.copyOfRange(pending, total, pending.length);
      if (crc(a, total - 2) != (((a[total - 2] & 255) << 8) | (a[total - 1] & 255)))
        throw new IllegalArgumentException("Не совпала контрольная сумма ответа");
      byte[] body;
      int slice = a[3] & 255;
      if (slice == 0) {
        if (slices != null) throw new IllegalArgumentException("Прерван фрагментированный ответ");
        body = Arrays.copyOfRange(a, 4, total - 2);
      } else {
        if (slice < 1 || slice > 3 || total < 8)
          throw new IllegalArgumentException("Неизвестная фрагментация");
        int number = a[4] & 255;
        if (slice == 1) {
          if (slices != null || number != 0)
            throw new IllegalArgumentException("Повторный первый фрагмент");
          slices = new byte[0];
          sliceNumber = 0;
        }
        if (slices == null || number != sliceNumber++)
          throw new IllegalArgumentException("Нарушен порядок фрагментов");
        byte[] chunk = Arrays.copyOfRange(a, 5, total - 2);
        if (slices.length + chunk.length > 8192)
          throw new IllegalArgumentException("Слишком длинный составной ответ");
        int n = slices.length;
        slices = Arrays.copyOf(slices, n + chunk.length);
        System.arraycopy(chunk, 0, slices, n, chunk.length);
        if (slice != 3) continue;
        body = slices;
        slices = null;
      }
      if (body.length < 2) throw new IllegalArgumentException("Нет команды в ответе");
      if ((expectedService == 0x0a || expectedService == 0x2c) && expectedCommand == 5
          && (body[0] & 255) == expectedService && body[1] == 4) {
        Map<Integer, byte[]> ack = new LinkedHashMap<>();
        ack.put(-2, Arrays.copyOfRange(body, 2, body.length));
        return ack;
      }
      if ((body[0] & 255) != expectedService || (body[1] & 255) != expectedCommand) {
        if (unsolicited != null
            && (body[0] & 255) == 0x25
            && ((body[1] & 255) == 1 || (body[1] & 255) == 3))
          unsolicited.accept(
              body[0] & 255, body[1] & 255, parseTlv(Arrays.copyOfRange(body, 2, body.length)));
        continue;
      }
      if ((expectedService == 0x2c || expectedService == 0x0a) && expectedCommand == 5) {
        Map<Integer, byte[]> raw = new LinkedHashMap<>();
        raw.put(-1, Arrays.copyOfRange(body, 2, body.length));
        return raw;
      }
      return parseTlv(Arrays.copyOfRange(body, 2, body.length));
    }
    return null;
  }

  static Map<Integer, byte[]> parseTlv(byte[] a) {
    if (a.length > 8192) throw new IllegalArgumentException("Слишком длинный TLV");
    Map<Integer, byte[]> tags = new LinkedHashMap<>();
    int end = a.length;
    for (int p = 0; p < end; ) {
      int tag = a[p++] & 255, n = 0, b, k = 0;
      do {
        if (p >= end || ++k > 3) throw new IllegalArgumentException("Некорректный TLV");
        b = a[p++] & 255;
        n = (n << 7) | (b & 127);
      } while ((b & 128) != 0);
      if (n > end - p || tags.containsKey(tag))
        throw new IllegalArgumentException("Некорректные поля ответа");
      tags.put(tag, Arrays.copyOfRange(a, p, p + n));
      p += n;
    }
    return tags;
  }

  static List<byte[]> values(byte[] a, int wanted) {
    if (a.length > 8192) throw new IllegalArgumentException("Слишком длинный TLV");
    List<byte[]> out = new ArrayList<>();
    for (int p = 0; p < a.length; ) {
      int tag = a[p++] & 255, n = 0, b, k = 0;
      do {
        if (p >= a.length || ++k > 3) throw new IllegalArgumentException("Некорректный TLV");
        b = a[p++] & 255;
        n = (n << 7) | (b & 127);
      } while ((b & 128) != 0);
      if (n > a.length - p) throw new IllegalArgumentException("Некорректные поля ответа");
      if (tag == wanted) out.add(Arrays.copyOfRange(a, p, p + n));
      p += n;
    }
    return out;
  }

  static long steps(Map<Integer, byte[]> tags) {
    byte[] container = tags.get(129);
    if (container == null) throw new IllegalArgumentException("Нет контейнера счётчиков шагов");
    List<byte[]> counters = values(container, 131);
    if (counters.isEmpty() || counters.size() > 256)
      throw new IllegalArgumentException("Нет счётчиков шагов");
    long total = 0;
    boolean found = false;
    for (byte[] counter : counters) {
      Map<Integer, byte[]> values = parseTlv(counter);
      byte[] count = values.get(5);
      if (count == null) continue;
      if (count.length != 4) throw new IllegalArgumentException("Неверная длина счётчика шагов");
      long n = 0;
      for (byte b : count) n = (n << 8) | (b & 255);
      if (n > 1000000 || total + n > 1000000)
        throw new IllegalArgumentException("Некорректный счётчик шагов");
      total += n;
      found = true;
    }
    if (!found) throw new IllegalArgumentException("В ответе нет шагов");
    return total;
  }

  static String report(Map<Integer, byte[]> tags) {
    StringBuilder out = new StringBuilder("Получен ответ Huawei LinkParams\n");
    int[] ids = {1, 2, 3, 7, 8, 9, 12};
    String[] labels = {
      "Протокол",
      "Размер фрагмента",
      "MTU протокола",
      "Тип поддержки",
      "Алгоритм авторизации",
      "Состояние привязки",
      "Шифрование"
    };
    for (int i = 0; i < ids.length; i++) {
      byte[] a = tags.get(ids[i]);
      if (a != null && a.length > 0 && a.length <= 2) {
        int n = 0;
        for (byte b : a) n = (n << 8) | (b & 255);
        out.append(labels[i]).append(": ").append(n).append('\n');
      }
    }
    byte[] auth = tags.get(5);
    if (auth != null && auth.length >= 2)
      out.append("Версия авторизации: ").append(auth[1] & 255).append('\n');
    byte[] result = tags.get(127);
    if (result != null && result.length == 4) {
      long n = 0;
      for (byte b : result) n = (n << 8) | (b & 255);
      out.append("Код результата: ").append(n).append('\n');
    }
    out.append("Поля:");
    for (int tag : tags.keySet()) out.append(' ').append(Integer.toHexString(tag));
    return out.toString();
  }
}

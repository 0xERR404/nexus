package xyz.nexus404.hecate;

import java.util.*;
import org.json.*;

/** Bounded Huawei 2C download; no file is parsed before authenticated SHA-256 verification. */
final class BandFiles {
  static final int MAX_FILE = 1024 * 1024;
  final BandHistory history;
  final boolean dictSleep, bedTime, stressEnabled;
  int savedRecords;
  int stage, kind = -1, fileId, size, position, windowEnd, maxBlock = 1024;
  boolean noEncrypt, done;
  private boolean sleepSupported, stressSupported;
  private boolean sleepNewSync, stressNewSync;
  BandLegacyFile legacy;
  String capabilitiesReport = "";
  private byte[] data, hash;
  final ArrayDeque<Integer> workouts = new ArrayDeque<>();
  int workout, workoutPage, workoutCount;
  boolean detailSupported;
  Boolean workoutSupported, fileSupported;
  final Map<Integer, Integer> pageCounts = new HashMap<>();
  JSONArray records = new JSONArray();
  String status = "Проверка расширенной истории";

  BandFiles(BandHistory history, boolean dictSleep, boolean bedTime, boolean stressEnabled) {
    this.history = history;
    this.dictSleep = dictSleep;
    this.bedTime = bedTime;
    this.stressEnabled = stressEnabled;
  }

  BandAuth.Request request(int service, int command, byte[] fields, String text) {
    return new BandAuth.Request(service, command, fields, text);
  }

  BandAuth.Request begin() {
    stage = -3;
    return request(
        1,
        3,
        BandAuth.tlv(
            129,
            BandAuth.tlv(
                2,
                new byte[] {0x17},
                3,
                history.metricsEnabled ? new byte[] {7, 8, 10} : new byte[] {7, 8})),
        "Возможности истории тренировок · 17");
  }

  BandAuth.Request fileBegin() {
    stage = 0;
    return request(
        1,
        3,
        BandAuth.tlv(129, BandAuth.tlv(2, new byte[] {0x2c}, 3, new byte[] {1, 2, 3, 4, 5, 6})),
        "Возможности файлового обмена · 2C");
  }

  BandAuth.Request settings() {
    stage = 1;
    return request(1, 0x31,
        BandAuth.tlv(1, new byte[0], 2, new byte[0], 3, new byte[0],
            4, new byte[0], 5, new byte[0], 6, new byte[0]),
        "Параметры синхронизации файлов · 01/31");
  }

  static boolean[] capabilities(Map<Integer, byte[]> tags, int service, int count) {
    byte[] b = tags.get(129);
    if (b == null) throw new IllegalArgumentException("Нет возможностей файлового обмена");
    Map<Integer, byte[]> f = BandProtocol.parseTlv(b);
    byte[] flags = f.get(4);
    if (BandProtocol.number(f, 2) != service || flags == null || flags.length != count)
      throw new IllegalArgumentException("Неверные возможности файлового обмена");
    boolean[] result = new boolean[count];
    for (int i = 0; i < count; i++) {
      if (flags[i] != 0 && flags[i] != 1)
        throw new IllegalArgumentException("Неверная маска возможностей");
      result[i] = flags[i] == 1;
    }
    return result;
  }

  BandAuth.Request accept(Map<Integer, byte[]> tags) throws Exception {
    BandAuth.checkResult(tags);
    if (legacy != null) return legacy.accept(tags);
    if (stage == -3) {
      boolean[] caps = capabilities(tags, 0x17, history.metricsEnabled ? 3 : 2);
      detailSupported = history.metricsEnabled && caps[2];
      workoutSupported = caps[0] && caps[1];
      if (!caps[0] || !caps[1]) return fileBegin();
      stage = -2;
      return request(
          0x17,
          7,
          BandAuth.tlv(
              129,
              BandAuth.tlv(
                  3,
                  BandHistory.integer((history.until - 7 * 86400000L) / 1000),
                  4,
                  BandHistory.integer(history.until / 1000))),
          "Список тренировок за 7 дней · 17/07");
    }
    if (stage == -2) {
      byte[] body = tags.get(129);
      if (body == null) throw new IllegalArgumentException("Нет списка тренировок");
      long count = BandHistory.uint(BandHistory.one(body, 2), 2);
      List<byte[]> list = BandProtocol.values(body, 133);
      if (count == 0) {
        workouts.clear();
        return fileBegin();
      }
      if (count > 128 || list.size() != count)
        throw new IllegalArgumentException(
            "Список тренировок: заявлено "
                + count
                + ", контейнеров "
                + list.size()
                + "; формат не подтверждён");
      Set<Integer> unique = new HashSet<>();
      for (byte[] entry : list) {
        int id = (int) BandHistory.uint(BandHistory.one(entry, 6), 2);
        if (!unique.add(id)) throw new IllegalArgumentException("Повтор номера тренировки");
        List<byte[]> pages = BandProtocol.values(entry, 7);
        int pagesCount = pages.isEmpty() ? 0 : (int) BandHistory.uint(pages.get(0), 2);
        if (pages.size() > 1 || pagesCount > 512)
          throw new IllegalArgumentException("Слишком много страниц тренировки");
        pageCounts.put(id, pagesCount);
        workouts.add(id);
      }
      return nextWorkout();
    }
    if (stage == -1) {
      byte[] body = tags.get(129);
      if (body == null) throw new IllegalArgumentException("Нет сводки тренировки");
      if (BandHistory.uint(BandHistory.one(body, 2), 2) != workout)
        throw new IllegalArgumentException("Другой номер тренировки");
      long start = BandHistory.uint(BandHistory.one(body, 4), 4) * 1000L,
          end = BandHistory.uint(BandHistory.one(body, 5), 4) * 1000L;
      if (start >= 946684800000L
          && end > start
          && end <= history.until
          && end - start <= 7 * 86400000L) {
        JSONObject r =
            history
                .record("activity", start, end)
                .put("id", "band:" + history.device + ":workout:" + start);
        if (stressEnabled) {
          JSONObject metrics = new JSONObject();
          int[] ids = {6, 7, 8, 18, 20};
          String[] names = {"calories", "distance", "steps", "duration", "kind"};
          for (int i = 0; i < ids.length; i++) {
            List<byte[]> fields = BandProtocol.values(body, ids[i]);
            if (fields.size() > 1) throw new IllegalArgumentException("Повтор поля тренировки");
            if (!fields.isEmpty()) {
              long value = BandHistory.uint(fields.get(0), ids[i] == 20 ? 1 : 4);
              long[] limits = {100000, 10000000, 1000000, 604800, 255};
              if (value <= limits[i]) metrics.put(names[i], value);
            }
          }
          if (history.metricsEnabled) {
            JSONObject raw = new JSONObject();
            Map<Integer, byte[]> all = BandProtocol.parseTlv(body);
            for (Map.Entry<Integer, byte[]> field : all.entrySet())
              if (field.getValue().length <= 1024)
                raw.put(Integer.toHexString(field.getKey()), BandAuth.hex(field.getValue()));
            r.put("deviceFields", raw);
          }
          r.put("workout", metrics);
        }
        records.put(r);
      }
      workoutPage = 0;
      workoutCount = detailSupported ? pageCounts.getOrDefault(workout, 0) : 0;
      return nextWorkoutPage();
    }
    if (stage == -4) {
      records.put(BandWorkout.page(tags, history, workout, workoutPage));
      workoutPage++;
      return nextWorkoutPage();
    }
    if (stage == 0) {
      boolean[] caps = capabilities(tags, 0x2c, 6);
      StringBuilder report = new StringBuilder("Ответ 01/03 для 2C:");
      for (int i = 0; i < caps.length; i++) report.append(" ").append(i + 1).append("=").append(caps[i] ? 1 : 0);
      capabilitiesReport = report.toString();
      // File routing is advertised by 01/31, not the generic command bitmap.
      return settings();
    }
    if (stage == 1) {
      int flags = BandProtocol.number(tags, 2);
      if (flags < 0) throw new IllegalArgumentException("Нет параметров синхронизации файлов");
      sleepNewSync = (flags & 2) != 0;
      stressNewSync = (flags & 4) != 0;
      sleepSupported = true;
      stressSupported = stressEnabled;
      fileSupported = true;
      capabilitiesReport = "01/31: " + flags + " · сон=" + (dictSleep || sleepNewSync ? "2C" : "0A")
          + " · стресс=" + (stressNewSync ? "2C" : "0A") + " · словарь=" + dictSleep;
      return next();
    }
    if (stage == 2) {
      byte[] name = tags.get(1);
      if (name == null
          || !Arrays.equals(name, BandAuth.utf(filename()))
          || BandProtocol.number(tags, 2) != fileType())
        throw new IllegalArgumentException("Браслет вернул другой файл");
      fileId = (int) BandHistory.uint(tags.get(3), 1);
      long length = BandHistory.uint(tags.get(4), 4);
      if (length > MAX_FILE)
        throw new IllegalArgumentException("Файл истории превышает 1 МиБ или недоступен");
      size = (int) length;
      position = 0;
      data = new byte[size];
      stage = 3;
      return request(
          0x2c,
          2,
          BandAuth.tlv(1, new byte[] {(byte) fileId}, 2, new byte[] {1}),
          "Проверка целостности файла · 2C/02");
    }
    if (stage == 3) {
      sameId(tags);
      hash = BandAuth.required(tags, 3, 32, 32).clone();
      if (size == 0) return verified();
      stage = 4;
      return request(
          0x2c,
          3,
          BandAuth.tlv(
              1,
              new byte[] {(byte) fileId},
              2,
              new byte[0],
              3,
              new byte[0],
              4,
              new byte[0],
              5,
              new byte[0]),
          "Параметры передачи файла · 2C/03");
    }
    if (stage == 4) {
      sameId(tags);
      long block = BandHistory.uint(tags.get(4), 4);
      if (block < 1 || block > MAX_FILE)
        throw new IllegalArgumentException("Неверный размер блока файла");
      maxBlock = (int) Math.min(block, 1024);
      int flag = BandProtocol.number(tags, 5);
      if (flag != 0 && flag != 1)
        throw new IllegalArgumentException("Неизвестный режим шифрования файла");
      noEncrypt = flag == 1;
      return block();
    }
    throw new IllegalArgumentException("Неожиданный ответ файлового обмена");
  }

  BandAuth.Request nextWorkout() {
    if (workouts.isEmpty()) return fileBegin();
    workout = workouts.removeFirst();
    stage = -1;
    return request(
        0x17,
        8,
        BandAuth.tlv(129, BandAuth.tlv(2, new byte[] {(byte) (workout >> 8), (byte) workout})),
        "Сводка тренировки · 17/08");
  }

  BandAuth.Request nextWorkoutPage() {
    if (workoutPage >= workoutCount) return nextWorkout();
    stage = -4;
    return request(
        0x17,
        10,
        BandAuth.tlv(
            129,
            BandAuth.tlv(
                2,
                new byte[] {(byte) (workout >> 8), (byte) workout},
                3,
                new byte[] {(byte) (workoutPage >> 8), (byte) workoutPage},
                7,
                new byte[0])),
        "Отсчёты тренировки · " + (workoutPage + 1) + "/" + workoutCount);
  }

  void sameId(Map<Integer, byte[]> tags) {
    if (BandProtocol.number(tags, 1) != fileId)
      throw new IllegalArgumentException("Изменился идентификатор файла");
  }

  String filename() {
    return kind == 0 ? (dictSleep ? "sequence_data" : "sleep_state.bin") : "rrisqi_data.bin";
  }

  int fileType() { return kind == 0 ? (dictSleep ? 0x16 : 0x0e) : 0x10; }

  int dataService() { return legacy == null ? 0x2c : 0x0a; }
  boolean receiving() { return legacy == null ? stage == 5 : legacy.receiving(); }

  BandAuth.Request next() {
    legacy = null;
    data = null;
    hash = null;
    kind++;
    if (kind == 0 && !sleepSupported) kind++;
    if (kind == 1 && !stressSupported) kind++;
    if (kind > 1) {
      done = true;
      status =
          "Расширенная история обработана · записей: "
              + (savedRecords + records.length())
              + (!sleepSupported ? " · словарный сон не подтверждён" : "")
              + (!stressSupported ? " · стресс недоступен" : "");
      return null;
    }
    stage = 2;
    if ((kind == 0 && !dictSleep && !sleepNewSync) || (kind == 1 && !stressNewSync)) {
      legacy = new BandLegacyFile(this);
      return legacy.begin();
    }
    byte[] fields =
        BandAuth.tlv(
            1,
            BandAuth.utf(filename()),
            2,
            new byte[] {(byte) fileType()},
            5,
            BandHistory.integer((history.until - (kind == 0 ? 3 : 7) * 86400000L) / 1000),
            6,
            BandHistory.integer(history.until / 1000));
    if (kind == 0 && dictSleep) fields = BandAuth.concat(fields, BandAuth.tlv(12, BandHistory.integer(700013)));
    return request(
        0x2c,
        1,
        fields,
        kind == 0
            ? "Чтение сна · " + filename()
            : "Чтение истории стресса · rrisqi_data.bin");
  }

  BandAuth.Request block() {
    stage = 5;
    windowEnd = Math.min(size, position + maxBlock);
    byte[] f =
        BandAuth.tlv(
            1,
            new byte[] {(byte) fileId},
            2,
            BandHistory.integer(position),
            3,
            BandHistory.integer(windowEnd - position));
    if (kind == 0 && dictSleep) f = BandAuth.concat(f, BandAuth.tlv(4, BandHistory.integer(700013)));
    return request(0x2c, 4, f, "Файл истории · " + position + "/" + size + " байт");
  }

  BandAuth.Request data(byte[] packet, byte[] key) throws Exception {
    if (legacy != null) return legacy.data(packet, key);
    if (stage != 5) throw new IllegalArgumentException("Блок вне передачи файла");
    byte[] raw = packet;
    if (packet.length >= 3 && packet[0] == 124 && packet[1] == 1 && packet[2] == 1)
      raw = BandAuth.decryptedBytes(key, BandProtocol.parseTlv(packet));
    else if (!noEncrypt)
      throw new java.security.GeneralSecurityException("Незашифрованный блок файла");
    if (raw.length < 7 || (raw[0] & 255) != fileId)
      throw new IllegalArgumentException("Неверный блок файла");
    long offset = BandHistory.uint(Arrays.copyOfRange(raw, 1, 5), 4);
    int length = raw.length - 6;
    if (offset != position || length > windowEnd - position)
      throw new IllegalArgumentException("Нарушен порядок или размер блоков файла");
    System.arraycopy(raw, 6, data, position, length);
    position += length;
    if (position == size) return verified();
    if (position == windowEnd) return block();
    return null;
  }

  BandAuth.Request verified() throws Exception {
    if (!java.security.MessageDigest.isEqual(hash, BandAuth.sha(data)))
      throw new java.security.GeneralSecurityException("Не совпал SHA-256 истории браслета");
    JSONArray parsed =
        size == 0
            ? new JSONArray()
            : kind == 0
                ? (dictSleep ? BandDetails.sleep(data, history, bedTime) : BandLegacyFile.sleepState(data, history))
                : BandDetails.stress(data, history);
    if (records.length() + parsed.length() > 10000)
      throw new IllegalArgumentException("Слишком много записей расширенной истории");
    for (int i = 0; i < parsed.length(); i++) records.put(parsed.getJSONObject(i));
    stage = 6;
    return request(
        0x2c,
        6,
        BandAuth.tlv(1, new byte[] {(byte) fileId}, 2, new byte[] {1}),
        "Файл проверен · записей: " + parsed.length());
  }

  boolean rawRequest() {
    return legacy == null && stage == 5 && noEncrypt;
  }

  boolean noReply() {
    return legacy == null ? stage == 6 : legacy.complete;
  }
}

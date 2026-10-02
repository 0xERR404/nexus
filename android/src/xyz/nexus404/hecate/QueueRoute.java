package xyz.nexus404.hecate;

import java.io.IOException;
import org.json.*;

final class QueueRoute {
  static JSONObject prepare(JSONObject old, JSONObject next, boolean pending, boolean confirmed)
      throws Exception {
    JSONObject result = new JSONObject(next.toString());
    result.remove("queueTargets");
    if (!pending) return result;
    if (old == null) throw new IOException("Не найдено прежнее подключение очереди");
    String before = BandUpload.target(old), after = BandUpload.target(next);
    if (!before.equals(after)) {
      if (!old.getString("origin").equals(next.getString("origin")))
        throw new IOException("С накопленной очередью можно заменить ключ только на том же хабе");
      if (!confirmed)
        throw new IOException("Подтверди отправку накопленной очереди с новым ключом");
    }
    JSONArray targets = new JSONArray();
    targets.put(before);
    JSONArray previous = old.optJSONArray("queueTargets");
    if (previous != null) for (int i = 0; i < previous.length(); i++) {
      String value = previous.getString(i);
      if (!value.matches("[A-F0-9]{64}")) throw new IOException("Повреждена привязка очереди");
      boolean found = false;
      for (int j = 0; j < targets.length(); j++) if (targets.getString(j).equals(value)) found = true;
      if (!found) targets.put(value);
    }
    return result.put("queueTargets", targets);
  }

  static boolean accepts(JSONObject cfg, String target) throws Exception {
    if (BandUpload.target(cfg).equals(target)) return true;
    JSONArray previous = cfg.optJSONArray("queueTargets");
    if (previous != null) for (int i = 0; i < previous.length(); i++)
      if (previous.getString(i).equals(target)) return true;
    return false;
  }
}

package xyz.nexus404.hecate;

import org.json.*;

public final class QueueRouteTest {
  static JSONObject config(String host, String token) throws Exception {
    return new JSONObject().put("origin", host).put("token", token);
  }
  static void ok(boolean value) { if (!value) throw new AssertionError(); }
  static void reject(JSONObject old, JSONObject next, boolean confirm) throws Exception {
    try {
      QueueRoute.prepare(old, next, true, confirm);
      throw new AssertionError("Unsafe queue transfer accepted");
    } catch (java.io.IOException expected) {}
  }
  public static void main(String[] args) throws Exception {
    JSONObject old = config("https://hub.example", "old");
    JSONObject next = config("https://hub.example", "new");
    String original = old.toString(), untouched = next.toString();
    reject(old, next, false);
    reject(old, config("https://other.example", "new"), true);
    reject(null, next, true);
    JSONObject migrated = QueueRoute.prepare(old, next, true, true);
    ok(old.toString().equals(original) && next.toString().equals(untouched));
    migrated = new JSONObject(migrated.toString());
    ok(QueueRoute.accepts(migrated, BandUpload.target(old)));
    ok(QueueRoute.accepts(migrated, BandUpload.target(next)));
    ok(!QueueRoute.accepts(migrated, BandUpload.target(config("https://other.example", "old"))));
    ok(!QueueRoute.accepts(migrated, BandUpload.target(config("https://hub.example", "unrelated"))));
    JSONObject resaved = QueueRoute.prepare(migrated, next, true, false);
    ok(QueueRoute.accepts(resaved, BandUpload.target(old)));
    JSONObject third = config("https://hub.example", "third");
    JSONObject again = QueueRoute.prepare(resaved, third, true, true);
    ok(QueueRoute.accepts(again, BandUpload.target(old)));
    ok(QueueRoute.accepts(again, BandUpload.target(next)));
    ok(QueueRoute.accepts(again, BandUpload.target(third)));
    JSONObject clean = QueueRoute.prepare(again, third, false, false);
    ok(!QueueRoute.accepts(clean, BandUpload.target(old)));
    ok(!clean.has("queueTargets"));
    JSONObject injected = config("https://hub.example", "fresh").put("queueTargets", new JSONArray().put("unrelated"));
    ok(!QueueRoute.prepare(null, injected, false, false).has("queueTargets"));
    System.out.println("Queue key rotation: same hub, explicit consent, persisted routing, repeated rotation and isolation OK");
  }
}

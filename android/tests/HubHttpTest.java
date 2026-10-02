package xyz.nexus404.hecate;

import org.json.JSONObject;

public final class HubHttpTest {
  static void ok(boolean value) {
    if (!value) throw new AssertionError();
  }

  public static void main(String[] args) throws Exception {
    for (String state : new String[] {"accepted", "pending", "ignored", "dismissed"})
      ok(new HubHttp.Result(200, new JSONObject().put("state", state)).acknowledged());
    for (String state : new String[] {"", "ready", "unexpected"})
      ok(!new HubHttp.Result(200, new JSONObject().put("state", state)).acknowledged());
    ok(!new HubHttp.Result(500, new JSONObject().put("state", "accepted")).acknowledged());
    HubHttp.Call stopped = new HubHttp.Call(), other = new HubHttp.Call();
    stopped.cancel();
    ok(stopped.stopped && !other.stopped);
    try {
      stopped.post(new JSONObject(), "/ignored", new JSONObject());
      throw new AssertionError();
    } catch (InterruptedException expected) {
    }
    try {
      other.post(new JSONObject().put("origin", "http://localhost"), "/ignored", new JSONObject());
      throw new AssertionError();
    } catch (java.io.IOException expected) {
    }
    System.out.println(
        "Hub HTTP: explicit receipts, independent cancellation and HTTPS required OK");
  }
}

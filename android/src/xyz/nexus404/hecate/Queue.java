package xyz.nexus404.hecate;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.DatabaseUtils;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import org.json.JSONObject;

final class Queue extends SQLiteOpenHelper {
  Queue(Context c) {
    super(c, "queue.db", null, 1);
    setWriteAheadLoggingEnabled(true);
  }

  public void onCreate(SQLiteDatabase db) {
    db.execSQL(
        "CREATE TABLE events(id TEXT PRIMARY KEY,payload TEXT NOT NULL,state TEXT NOT NULL,created"
            + " INTEGER NOT NULL)");
  }

  public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
    throw new IllegalStateException("Unsupported schema");
  }

  synchronized boolean add(String id, JSONObject data) throws Exception {
    SQLiteDatabase db = getWritableDatabase();
    if (DatabaseUtils.longForQuery(db, "SELECT count(*) FROM events WHERE id=?", new String[] {id})
        > 0) return false;
    if (DatabaseUtils.longForQuery(db, "SELECT count(*) FROM events WHERE state!='sent'", null)
        >= 1000) throw new IllegalStateException("Очередь заполнена");
    ContentValues row = new ContentValues();
    row.put("id", id);
    row.put("payload", Vault.seal(data.toString()));
    row.put("state", "pending");
    row.put("created", System.currentTimeMillis());
    db.insertOrThrow("events", null, row);
    return true;
  }

  JSONObject first() throws Exception {
    try (Cursor c =
        getReadableDatabase()
            .rawQuery(
                "SELECT payload FROM events WHERE state='pending' ORDER BY created LIMIT 1",
                null)) {
      return c.moveToFirst() ? new JSONObject(Vault.open(c.getString(0))) : null;
    }
  }

  void mark(String id, String state) {
    ContentValues row = new ContentValues();
    row.put("state", state);
    if (state.equals("sent")) row.put("payload", "");
    getWritableDatabase().update("events", row, "id=?", new String[] {id});
    getWritableDatabase()
        .delete(
            "events",
            "state='sent' AND created<?",
            new String[] {String.valueOf(System.currentTimeMillis() - 30L * 86400000)});
  }

  long count(String state) {
    return DatabaseUtils.longForQuery(
        getReadableDatabase(), "SELECT count(*) FROM events WHERE state=?", new String[] {state});
  }

  void clear() {
    getWritableDatabase().delete("events", null, null);
  }
}

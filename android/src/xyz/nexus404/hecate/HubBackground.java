package xyz.nexus404.hecate;

import android.graphics.*;
import android.graphics.drawable.Drawable;

final class HubBackground extends Drawable {
  private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);

  public void draw(Canvas canvas) {
    Rect r = getBounds();
    paint.setShader(
        new LinearGradient(
            0,
            0,
            r.width(),
            r.height(),
            new int[] {0xff18212e, 0xff080b12, 0xff0d151e},
            null,
            Shader.TileMode.CLAMP));
    canvas.drawRect(r, paint);
    paint.setShader(null);
    paint.setColor(0x087f99b4);
    paint.setStrokeWidth(1);
    for (int y = 0; y < r.height(); y += 5) canvas.drawLine(0, y, r.width(), y, paint);
  }

  public void setAlpha(int a) {}

  public void setColorFilter(ColorFilter f) {}

  public int getOpacity() {
    return PixelFormat.OPAQUE;
  }
}

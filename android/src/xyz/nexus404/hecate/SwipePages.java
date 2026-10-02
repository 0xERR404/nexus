package xyz.nexus404.hecate;

import android.app.Activity;
import android.content.Context;
import android.graphics.drawable.GradientDrawable;
import android.view.*;
import android.widget.*;

/** Native pages with independent scroll positions and accessible tap navigation. */
final class SwipePages extends LinearLayout {
  final LinearLayout[] pages;
  final ScrollView[] scrolls;
  final Button[] tabs;
  final FrameLayout body;
  final HorizontalScrollView rail;
  final TextView feedback;
  int selected;
  Runnable onChanged;
  float downX, downY;
  boolean swiping, blocked;

  SwipePages(Activity activity, String title, String... names) {
    super(activity);
    setOrientation(VERTICAL); setFitsSystemWindows(true); setBackground(new HubBackground());
    TextView heading = new TextView(activity);
    heading.setText(title); heading.setTextColor(0xffe5edf7); heading.setTextSize(19);
    heading.setTypeface(android.graphics.Typeface.MONOSPACE);
    heading.setPadding(dp(14),dp(12),dp(14),dp(6)); addView(heading);
    rail = new HorizontalScrollView(activity); rail.setHorizontalScrollBarEnabled(false);
    LinearLayout row = new LinearLayout(activity); row.setOrientation(HORIZONTAL); rail.addView(row);
    addView(rail,new LayoutParams(-1,-2));
    feedback = new TextView(activity); feedback.setTextSize(12); feedback.setTextColor(0xffb5c8dc);
    feedback.setPadding(dp(14),dp(5),dp(14),dp(5)); feedback.setVisibility(GONE);
    feedback.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); addView(feedback);
    body = new FrameLayout(activity) {
      public boolean onInterceptTouchEvent(MotionEvent e) {
        if (e.getActionMasked() == MotionEvent.ACTION_DOWN) {
          downX=e.getX(); downY=e.getY(); swiping=false;
          blocked=editingAt(this,e.getRawX(),e.getRawY());
        }
        if (e.getActionMasked() == MotionEvent.ACTION_MOVE && !blocked
            && horizontal(e.getX()-downX,e.getY()-downY,dp(24))) swiping=true;
        return swiping;
      }
      public boolean onTouchEvent(MotionEvent e) {
        if (e.getActionMasked() == MotionEvent.ACTION_UP) {
          float dx=e.getX()-downX, dy=e.getY()-downY;
          if (swiping && horizontal(dx,dy,dp(64))) show(selected + (dx < 0 ? 1 : -1));
          swiping=false; return true;
        }
        if (e.getActionMasked() == MotionEvent.ACTION_CANCEL) swiping=false;
        return true;
      }
    };
    addView(body,new LayoutParams(-1,0,1));
    pages=new LinearLayout[names.length]; scrolls=new ScrollView[names.length]; tabs=new Button[names.length];
    for(int i=0;i<names.length;i++) {
      final int index=i;
      Button tab=new Button(activity); tab.setText(names[i]); tab.setAllCaps(false); tab.setTextSize(13);
      tab.setMinimumHeight(dp(48)); tab.setMinHeight(dp(48));
      tab.setPadding(dp(12),0,dp(12),0); tab.setOnClickListener(v->show(index));
      row.addView(tab,new LayoutParams(-2,dp(48))); tabs[i]=tab;
      ScrollView scroll=new ScrollView(activity); scroll.setFillViewport(true);
      LinearLayout page=new LinearLayout(activity); page.setOrientation(VERTICAL);
      page.setPadding(dp(14),dp(8),dp(14),dp(24)); scroll.addView(page);
      body.addView(scroll,new FrameLayout.LayoutParams(-1,-1)); pages[i]=page; scrolls[i]=scroll;
    }
    show(0); activity.setContentView(this);
  }
  int dp(int n) { return Math.round(n*getResources().getDisplayMetrics().density); }
  LinearLayout page(int i) { return pages[i]; }
  static boolean horizontal(float dx,float dy,int threshold) { return Math.abs(dx)>threshold && Math.abs(dx)>Math.abs(dy)*1.5f; }
  static boolean editingAt(View v,float x,float y) {
    if(v.getVisibility()!=VISIBLE) return false;
    int[] p=new int[2];v.getLocationOnScreen(p);
    if(x<p[0] || y<p[1] || x>=p[0]+v.getWidth() || y>=p[1]+v.getHeight())return false;
    if(v instanceof EditText || v instanceof SeekBar || v instanceof Spinner || (v instanceof TextView && ((TextView)v).isTextSelectable()))return true;
    if(v instanceof ViewGroup) {
      ViewGroup g=(ViewGroup)v;
      for(int i=g.getChildCount()-1;i>=0;i--)if(editingAt(g.getChildAt(i),x,y))return true;
    }
    return false;
  }
  void show(int i) {
    if(i<0 || i>=pages.length)return;
    selected=i;
    for(int n=0;n<pages.length;n++) {
      scrolls[n].setVisibility(n==i?VISIBLE:GONE); tabs[n].setSelected(n==i);
      tabs[n].setTextColor(n==i?0xfff0f5fc:0xff9ba8b9);
      GradientDrawable bg=new GradientDrawable();bg.setColor(n==i?0xff253344:0x00131c29);
      bg.setCornerRadius(dp(8));tabs[n].setBackground(bg);
      tabs[n].setContentDescription(tabs[n].getText()+(n==i?", выбрана":""));
    }
    if(onChanged!=null)onChanged.run();
    rail.post(()->rail.smoothScrollTo(Math.max(0,tabs[i].getLeft()-dp(12)),0));
  }
  void message(String text) { feedback.setText(text);feedback.setVisibility(text.isEmpty()?GONE:VISIBLE); }
}

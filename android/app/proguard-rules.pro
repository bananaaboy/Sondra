# Nothing reached by reflection: the page talks to the app through
# androidx.webkit's WebMessageListener, not @JavascriptInterface.

# youtubedl-android reads yt-dlp's answers and its own updates with Jackson,
# by reflection.
-keep class com.yausername.** { *; }
-keep class com.fasterxml.jackson.** { *; }
-dontwarn com.fasterxml.jackson.**
-dontwarn org.apache.commons.**
-dontwarn java.beans.**

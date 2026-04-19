# Default rules + Kotlin reflection metadata for kotlinx.serialization.
# We deliberately keep our own data classes intact so the JSON converter
# can still reflect into them post-shrink.
-keep class com.goldinkollar.nexus.data.** { *; }
-keepclassmembers class kotlinx.serialization.** { *; }
-keepclasseswithmembers class * { @kotlinx.serialization.Serializable <init>(...); }

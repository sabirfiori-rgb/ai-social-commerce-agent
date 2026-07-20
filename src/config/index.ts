---
*** Begin Patch
*** Update File: src/config/index.ts
@@
-export type DatabaseDriver = 'sqlite' | 'postgres';
+export type DatabaseDriver = 'sqlite' | 'postgres';
@@
   db: {
-      driver: DatabaseDriver;
-      sqlitePath: string;
-      url: string;
+      driver: DatabaseDriver;
+      sqlitePath: string;
+      url: string;
     };
*** End Patch

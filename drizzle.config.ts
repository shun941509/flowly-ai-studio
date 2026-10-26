/**
 * D1과 호환되는 SQLite 스키마의 마이그레이션 생성 설정. 설정을 읽는 것만으로 운영 DB에 이관을 적용하지 않는다.
 */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./drizzle",
  schema: "./db/schema.ts",
  dialect: "sqlite",
});

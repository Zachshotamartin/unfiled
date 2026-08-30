import { Stack } from "expo-router";
import type { ReactElement } from "react";

export default function AuthLayout(): ReactElement {
  return <Stack screenOptions={{ animation: "fade", headerShown: false }} />;
}

import { Stack } from "expo-router";
import type { ReactElement } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";

import { nativeTheme } from "../theme/nativeTheme";

export default function RootLayout(): ReactElement {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          animation: "fade",
          contentStyle: { backgroundColor: nativeTheme.color.canvas },
          headerShown: false
        }}
      >
        <Stack.Screen name="(tabs)" />
        <Stack.Screen
          name="capture"
          options={{ animation: "fade", gestureEnabled: false, presentation: "fullScreenModal" }}
        />
      </Stack>
    </SafeAreaProvider>
  );
}

import { Stack } from "expo-router";
import type { ReactElement } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";

import { AuthProvider, useSession } from "../auth/AuthProvider";
import { nativeTheme } from "../theme/nativeTheme";

function RootNavigator(): ReactElement {
  const { lastProfileId, session, status } = useSession();
  if (status === "loading") {
    return (
      <View accessibilityLabel="Loading Unfiled" style={styles.loading}>
        <ActivityIndicator color={nativeTheme.color.accent} size="small" />
      </View>
    );
  }

  return (
    <Stack
      screenOptions={{
        animation: "fade",
        contentStyle: { backgroundColor: nativeTheme.color.canvas },
        headerShown: false
      }}
    >
      <Stack.Protected guard={session !== null}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="notes" />
        <Stack.Screen name="spaces" />
      </Stack.Protected>
      <Stack.Protected guard={session === null}>
        <Stack.Screen name="(auth)" />
      </Stack.Protected>
      <Stack.Protected guard={session !== null || lastProfileId !== null}>
        <Stack.Screen
          name="capture"
          options={{ animation: "fade", gestureEnabled: false, presentation: "fullScreenModal" }}
        />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout(): ReactElement {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <AuthProvider>
        <RootNavigator />
      </AuthProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  loading: {
    alignItems: "center",
    backgroundColor: nativeTheme.color.canvas,
    flex: 1,
    justifyContent: "center"
  }
});

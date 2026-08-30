import { Ionicons } from "@expo/vector-icons";
import { router, Tabs } from "expo-router";
import type { ComponentProps, ReactElement } from "react";
import { StyleSheet, View, type ColorValue } from "react-native";

import { BrandMark } from "../../components/BrandMark";
import { nativeTheme } from "../../theme/nativeTheme";

type IconName = ComponentProps<typeof Ionicons>["name"];

function TabIcon({ color, name }: { color: ColorValue; name: IconName }): ReactElement {
  return <Ionicons color={color} name={name} size={22} />;
}

function CaptureTabIcon(): ReactElement {
  return (
    <View style={styles.captureButton}>
      <BrandMark size={25} />
    </View>
  );
}

export default function TabsLayout(): ReactElement {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: nativeTheme.color.canvas },
        tabBarActiveTintColor: nativeTheme.color.textPrimary,
        tabBarInactiveTintColor: nativeTheme.color.textSecondary,
        tabBarLabelStyle: { fontSize: 10, fontWeight: "600", marginTop: 2 },
        tabBarStyle: {
          backgroundColor: nativeTheme.color.surface,
          borderTopColor: nativeTheme.color.border,
          height: 82,
          paddingBottom: 18,
          paddingTop: 8
        }
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          tabBarIcon: ({ color }) => <TabIcon color={color} name="today-outline" />,
          title: "Today"
        }}
      />
      <Tabs.Screen
        name="notes"
        options={{
          tabBarIcon: ({ color }) => <TabIcon color={color} name="documents-outline" />,
          title: "Notes"
        }}
      />
      <Tabs.Screen
        listeners={{
          tabPress: (event) => {
            event.preventDefault();
            router.push("/capture?source=mobile");
          }
        }}
        name="capture-action"
        options={{ tabBarIcon: () => <CaptureTabIcon />, title: "Capture" }}
      />
      <Tabs.Screen
        name="review"
        options={{
          tabBarIcon: ({ color }) => <TabIcon color={color} name="git-compare-outline" />,
          title: "Review"
        }}
      />
      <Tabs.Screen
        name="search"
        options={{
          tabBarIcon: ({ color }) => <TabIcon color={color} name="search-outline" />,
          title: "Search"
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  captureButton: {
    alignItems: "center",
    backgroundColor: nativeTheme.color.accent,
    borderRadius: 23,
    height: 46,
    justifyContent: "center",
    marginTop: -19,
    width: 46
  }
});

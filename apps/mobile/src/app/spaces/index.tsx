import { createEntityId } from "@unfiled/contracts";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useState, type ReactElement } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { Rule } from "../../components/Rule";
import { Screen } from "../../components/Screen";
import { MobileNotesError } from "../../features/notes/mobileNotesApi";
import { rankSpacesAfterMove } from "../../features/notes/spaceOrder";
import { useMobileNotesApi, useSpaces } from "../../features/notes/useNotesApi";
import { nativeTheme } from "../../theme/nativeTheme";

export default function SpacesScreen(): ReactElement {
  const api = useMobileNotesApi();
  const spaces = useSpaces();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const topSpaces = spaces.value.filter(({ parentId }) => parentId === null);

  const create = async (): Promise<void> => {
    const normalized = name.trim();
    if (api === null || normalized.length === 0 || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await api.createSpace(normalized, null, createEntityId("key"));
      setName("");
      await spaces.refresh();
    } catch (cause) {
      setMessage(cause instanceof MobileNotesError ? cause.message : "Couldn't create this space.");
    } finally {
      setBusy(false);
    }
  };

  const reorder = async (index: number, direction: -1 | 1): Promise<void> => {
    const updates = rankSpacesAfterMove(topSpaces, index, direction);
    if (api === null || updates.length === 0 || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await Promise.all(
        updates.map((space) =>
          api.updateSpace(
            space.id,
            { sortKey: space.sortKey },
            space.currentRevision,
            createEntityId("key")
          )
        )
      );
      await spaces.refresh();
    } catch (cause) {
      setMessage(cause instanceof MobileNotesError ? cause.message : "Couldn't reorder spaces.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen eyebrow="One level, no maze" title="Spaces">
      <View style={styles.createRow}>
        <TextInput
          accessibilityLabel="New space name"
          keyboardAppearance="dark"
          maxLength={60}
          onChangeText={setName}
          onSubmitEditing={() => void create()}
          placeholder="New space"
          placeholderTextColor={nativeTheme.color.textDisabled}
          returnKeyType="done"
          selectionColor={nativeTheme.color.accent}
          style={styles.input}
          value={name}
        />
        <Pressable
          accessibilityLabel="Create space"
          accessibilityRole="button"
          accessibilityState={{ disabled: name.trim().length === 0 || busy }}
          disabled={name.trim().length === 0 || busy}
          onPress={() => void create()}
          style={[styles.add, (name.trim().length === 0 || busy) && styles.disabled]}
        >
          <Ionicons color={nativeTheme.color.accentContrast} name="add" size={22} />
        </Pressable>
      </View>
      <Text accessibilityLiveRegion="polite" style={styles.message}>
        {message ?? spaces.error}
      </Text>
      {spaces.loading ? <ActivityIndicator color={nativeTheme.color.accent} /> : null}
      {!spaces.loading && spaces.value.length === 0 ? (
        <Text style={styles.empty}>
          Spaces are optional. Notes can stay Unfiled until a home helps.
        </Text>
      ) : null}
      {topSpaces.map((space, index) => (
        <View key={space.id}>
          <View style={styles.row}>
            <Pressable
              accessibilityLabel={`Open ${space.name}`}
              accessibilityRole="button"
              onPress={() =>
                router.push({ pathname: "/spaces/[spaceId]", params: { spaceId: space.id } })
              }
              style={styles.openSpace}
            >
              <Ionicons color={nativeTheme.color.textSecondary} name="folder-outline" size={21} />
              <View style={styles.body}>
                <Text style={styles.title}>{space.name}</Text>
                <Text style={styles.path}>Top-level space</Text>
              </View>
            </Pressable>
            <Pressable
              accessibilityLabel={`Move ${space.name} up`}
              accessibilityRole="button"
              accessibilityState={{ disabled: index === 0 || busy }}
              disabled={index === 0 || busy}
              onPress={() => void reorder(index, -1)}
              style={[styles.orderButton, index === 0 && styles.disabled]}
            >
              <Ionicons color={nativeTheme.color.textSecondary} name="chevron-up" size={18} />
            </Pressable>
            <Pressable
              accessibilityLabel={`Move ${space.name} down`}
              accessibilityRole="button"
              accessibilityState={{ disabled: index === topSpaces.length - 1 || busy }}
              disabled={index === topSpaces.length - 1 || busy}
              onPress={() => void reorder(index, 1)}
              style={[styles.orderButton, index === topSpaces.length - 1 && styles.disabled]}
            >
              <Ionicons color={nativeTheme.color.textSecondary} name="chevron-down" size={18} />
            </Pressable>
            <Ionicons color={nativeTheme.color.textSecondary} name="chevron-forward" size={18} />
          </View>
          <Rule />
        </View>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  add: {
    alignItems: "center",
    backgroundColor: nativeTheme.color.accent,
    borderRadius: 22,
    height: 44,
    justifyContent: "center",
    width: 44
  },
  body: { flex: 1 },
  createRow: { alignItems: "center", flexDirection: "row", gap: 10 },
  disabled: { opacity: 0.38 },
  empty: { color: nativeTheme.color.textSecondary, fontSize: 15, lineHeight: 23, paddingTop: 52 },
  input: {
    backgroundColor: nativeTheme.color.surface,
    borderColor: nativeTheme.color.border,
    borderRadius: nativeTheme.radius.input,
    borderWidth: StyleSheet.hairlineWidth,
    color: nativeTheme.color.textPrimary,
    flex: 1,
    fontSize: 16,
    minHeight: 48,
    paddingHorizontal: 14
  },
  message: { color: nativeTheme.color.danger, fontSize: 13, minHeight: 32, paddingTop: 8 },
  openSpace: { alignItems: "center", flex: 1, flexDirection: "row", gap: 13, minHeight: 72 },
  orderButton: { alignItems: "center", height: 44, justifyContent: "center", width: 38 },
  path: {
    color: nativeTheme.color.textSecondary,
    fontFamily: nativeTheme.fontFamily.mono,
    fontSize: 10,
    marginTop: 5
  },
  row: { alignItems: "center", flexDirection: "row", minHeight: 72 },
  title: { color: nativeTheme.color.textPrimary, fontSize: 16, fontWeight: "600" }
});

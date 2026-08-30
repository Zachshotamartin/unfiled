import { createEntityId } from "@unfiled/contracts";
import { router, useLocalSearchParams } from "expo-router";
import { useState, type ReactElement } from "react";
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { Rule } from "../../components/Rule";
import { Screen } from "../../components/Screen";
import { MobileNotesError } from "../../features/notes/mobileNotesApi";
import { useMobileNotesApi, useNoteList, useSpaces } from "../../features/notes/useNotesApi";
import { nativeTheme } from "../../theme/nativeTheme";

export default function SpaceDetailScreen(): ReactElement {
  const params = useLocalSearchParams<{ spaceId?: string }>();
  const spaceId = params.spaceId ?? "";
  const api = useMobileNotesApi();
  const spaces = useSpaces();
  const notes = useNoteList({ spaceId });
  const space = spaces.value.find((candidate) => candidate.id === spaceId);
  const [name, setName] = useState<string | null>(null);
  const [childName, setChildName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const currentName = name ?? space?.name ?? "";

  const rename = async (): Promise<void> => {
    if (api === null || space === undefined || currentName.trim().length === 0 || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await api.updateSpace(
        spaceId,
        { name: currentName.trim() },
        space.currentRevision,
        createEntityId("key")
      );
      setName(null);
      await spaces.refresh();
    } catch (cause) {
      setMessage(cause instanceof MobileNotesError ? cause.message : "Couldn't rename this space.");
    } finally {
      setBusy(false);
    }
  };

  const createChild = async (): Promise<void> => {
    const normalized = childName.trim();
    if (api === null || normalized.length === 0 || busy || space?.parentId !== null) return;
    setBusy(true);
    setMessage(null);
    try {
      await api.createSpace(normalized, spaceId, createEntityId("key"));
      setChildName("");
      await spaces.refresh();
    } catch (cause) {
      setMessage(
        cause instanceof MobileNotesError ? cause.message : "Couldn't create this nested space."
      );
    } finally {
      setBusy(false);
    }
  };

  const archive = (): void => {
    Alert.alert("Archive this space?", "Its notes stay intact and searchable.", [
      { style: "cancel", text: "Cancel" },
      {
        onPress: () => {
          if (api === null || space === undefined) return;
          setBusy(true);
          void api
            .archiveSpace(spaceId, space.currentRevision, createEntityId("key"))
            .then(() => router.back())
            .catch((cause: unknown) => {
              setMessage(
                cause instanceof MobileNotesError ? cause.message : "Couldn't archive this space."
              );
              setBusy(false);
            });
        },
        text: "Archive"
      }
    ]);
  };

  return (
    <Screen
      eyebrow={space?.parentId === null ? "Top-level space" : "Nested space"}
      title={space?.name ?? "Space"}
    >
      <View style={styles.renameRow}>
        <TextInput
          accessibilityLabel="Space name"
          keyboardAppearance="dark"
          maxLength={60}
          onChangeText={setName}
          onSubmitEditing={() => void rename()}
          selectionColor={nativeTheme.color.accent}
          style={styles.input}
          value={currentName}
        />
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => void rename()}>
          <Text style={styles.actionText}>Rename</Text>
        </Pressable>
      </View>
      <Text accessibilityLiveRegion="polite" style={styles.message}>
        {message ?? notes.error}
      </Text>
      {space?.parentId === null ? (
        <View style={styles.renameRow}>
          <TextInput
            accessibilityLabel="New nested space name"
            keyboardAppearance="dark"
            maxLength={60}
            onChangeText={setChildName}
            onSubmitEditing={() => void createChild()}
            placeholder="Add one nested space"
            placeholderTextColor={nativeTheme.color.textDisabled}
            returnKeyType="done"
            selectionColor={nativeTheme.color.accent}
            style={styles.input}
            value={childName}
          />
          <Pressable
            accessibilityRole="button"
            disabled={busy || childName.trim().length === 0}
            onPress={() => void createChild()}
          >
            <Text style={styles.actionText}>Add</Text>
          </Pressable>
        </View>
      ) : null}
      <Rule />
      {spaces.value
        .filter(({ parentId }) => parentId === spaceId)
        .map((child) => (
          <View key={child.id}>
            <Pressable
              accessibilityRole="button"
              onPress={() =>
                router.push({ pathname: "/spaces/[spaceId]", params: { spaceId: child.id } })
              }
              style={styles.noteRow}
            >
              <View style={styles.body}>
                <Text style={styles.title}>{child.name}</Text>
                <Text style={styles.detail}>Nested space</Text>
              </View>
              <Text style={styles.revision}>Open</Text>
            </Pressable>
            <Rule />
          </View>
        ))}
      {notes.value.map((note) => (
        <View key={note.id}>
          <Pressable
            accessibilityRole="button"
            onPress={() =>
              router.push({ pathname: "/notes/[noteId]", params: { noteId: note.id } })
            }
            style={styles.noteRow}
          >
            <View style={styles.body}>
              <Text style={styles.title}>{note.title}</Text>
              <Text numberOfLines={1} style={styles.detail}>
                {note.type} · {note.privacy === "private_manual" ? "Private" : "AI-assisted"}
              </Text>
            </View>
            <Text style={styles.revision}>r{note.currentRevision}</Text>
          </Pressable>
          <Rule />
        </View>
      ))}
      {!notes.loading && notes.value.length === 0 ? (
        <Text style={styles.empty}>No notes are filed here.</Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        disabled={busy}
        onPress={archive}
        style={styles.archive}
      >
        <Text style={styles.archiveText}>Archive space</Text>
      </Pressable>
    </Screen>
  );
}

const styles = StyleSheet.create({
  actionText: { color: nativeTheme.color.accent, fontSize: 13, fontWeight: "700", padding: 12 },
  archive: { justifyContent: "center", minHeight: 48, paddingTop: 28 },
  archiveText: { color: nativeTheme.color.textSecondary, fontSize: 14, fontWeight: "600" },
  body: { flex: 1 },
  detail: { color: nativeTheme.color.textSecondary, fontSize: 14, marginTop: 5 },
  empty: { color: nativeTheme.color.textSecondary, fontSize: 15, paddingTop: 42 },
  input: {
    borderBottomColor: nativeTheme.color.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    color: nativeTheme.color.textPrimary,
    flex: 1,
    fontSize: 16,
    minHeight: 48
  },
  message: { color: nativeTheme.color.danger, fontSize: 13, minHeight: 34, paddingTop: 8 },
  noteRow: { alignItems: "center", flexDirection: "row", minHeight: 76, paddingVertical: 12 },
  renameRow: { alignItems: "center", flexDirection: "row", gap: 8 },
  revision: {
    color: nativeTheme.color.textSecondary,
    fontFamily: nativeTheme.fontFamily.mono,
    fontSize: 10
  },
  title: { color: nativeTheme.color.textPrimary, fontSize: 16, fontWeight: "600" }
});

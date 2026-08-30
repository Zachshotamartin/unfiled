import { Ionicons } from "@expo/vector-icons";
import type { NoteLinkValue } from "@unfiled/contracts";
import { router } from "expo-router";
import {
  useEffect,
  useRef,
  useState,
  type ComponentRef,
  type ReactElement,
  type ReactNode
} from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { nativeTheme } from "../../theme/nativeTheme";
import { MarkdownPreview } from "./MarkdownPreview";
import { NoteMetadataFields } from "./NoteMetadataFields";
import {
  noteTypeLabel,
  type MobileNotePrivacy,
  type MobileNoteSummary,
  type MobileNoteType,
  type MobileSpace,
  type MobileTag
} from "./mobileNotesApi";

export interface NoteEditorValue {
  bodyMarkdown: string;
  links: NoteLinkValue[];
  privacy: MobileNotePrivacy;
  spaceId: string | null;
  tagIds: string[];
  title: string;
  type: MobileNoteType;
}

export interface NoteEditorSaveResult {
  revision: number;
  value: NoteEditorValue;
}

export function resolvedEditorTitle(value: NoteEditorValue): string {
  const explicit = value.title.trim();
  if (explicit.length > 0) return explicit;
  const firstLine = value.bodyMarkdown
    .split("\n")
    .map((line) => line.replace(/^\s*(?:#{1,6}|[-*+]>?|\d+\.)\s*/u, "").trim())
    .find((line) => line.length > 0);
  return firstLine?.slice(0, 80) ?? "Untitled note";
}

interface NoteEditorProps {
  busy: boolean;
  currentNoteId?: string;
  error: string | null;
  initialValue: NoteEditorValue;
  interactiveContent?: ReactNode;
  linkCandidates: MobileNoteSummary[];
  mode: "create" | "edit";
  onCreateTag?: (name: string) => Promise<MobileTag>;
  onReload?: () => Promise<void>;
  onSave: (
    value: NoteEditorValue,
    baseline: NoteEditorValue,
    expectedRevision: number
  ) => Promise<NoteEditorSaveResult | null>;
  revision?: number;
  secondaryActions?: ReactNode;
  spaces: MobileSpace[];
  tags: MobileTag[];
}

const noteTypes: MobileNoteType[] = ["generic", "list", "log", "principle", "project"];

export function NoteEditor({
  busy,
  currentNoteId,
  error,
  initialValue,
  interactiveContent,
  linkCandidates,
  mode,
  onCreateTag,
  onReload,
  onSave,
  revision,
  secondaryActions,
  spaces,
  tags
}: NoteEditorProps): ReactElement {
  const bodyRef = useRef<ComponentRef<typeof TextInput>>(null);
  const [value, setValue] = useState(initialValue);
  const [baseline, setBaseline] = useState(initialValue);
  const [baseRevision, setBaseRevision] = useState(revision ?? 0);
  const [past, setPast] = useState<NoteEditorValue[]>([]);
  const [future, setFuture] = useState<NoteEditorValue[]>([]);
  const [preview, setPreview] = useState(false);
  const dirty = JSON.stringify(value) !== JSON.stringify(baseline);
  const externalConflict = mode === "edit" && revision !== undefined && revision !== baseRevision;
  const canSave =
    (value.title.trim().length > 0 || value.bodyMarkdown.trim().length > 0) &&
    !busy &&
    dirty &&
    !externalConflict;

  useEffect(() => {
    if (mode !== "edit" || revision === undefined || revision === baseRevision || dirty) return;
    setValue(initialValue);
    setBaseline(initialValue);
    setBaseRevision(revision);
    setPast([]);
    setFuture([]);
  }, [baseRevision, dirty, initialValue, mode, revision]);

  const change = (update: (current: NoteEditorValue) => NoteEditorValue): void => {
    const next = update(value);
    if (next === value) return;
    setPast((entries) => [...entries.slice(-99), value]);
    setFuture([]);
    setValue(next);
  };

  const undo = (): void => {
    const previous = past.at(-1);
    if (previous === undefined) return;
    setPast((entries) => entries.slice(0, -1));
    setFuture((entries) => [value, ...entries].slice(0, 100));
    setValue(previous);
  };

  const redo = (): void => {
    const next = future[0];
    if (next === undefined) return;
    setFuture((entries) => entries.slice(1));
    setPast((entries) => [...entries.slice(-99), value]);
    setValue(next);
  };

  const insert = (prefix: string, suffix = ""): void => {
    const next = `${value.bodyMarkdown}${value.bodyMarkdown.length === 0 ? "" : "\n"}${prefix}${suffix}`;
    change((current) => ({ ...current, bodyMarkdown: next }));
    requestAnimationFrame(() => bodyRef.current?.focus());
  };

  const save = async (): Promise<void> => {
    const result = await onSave(value, baseline, baseRevision);
    if (result === null) return;
    setValue(result.value);
    setBaseline(result.value);
    setBaseRevision(result.revision);
    setPast([]);
    setFuture([]);
  };

  const reload = async (): Promise<void> => {
    setValue(initialValue);
    setBaseline(initialValue);
    setBaseRevision(revision ?? 0);
    setPast([]);
    setFuture([]);
    await onReload?.();
  };

  return (
    <SafeAreaView edges={["top", "bottom"]} style={styles.safeArea}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.safeArea}
      >
        <View style={styles.topBar}>
          <Pressable
            accessibilityLabel="Back"
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => router.back()}
            style={styles.iconButton}
          >
            <Ionicons color={nativeTheme.color.textPrimary} name="chevron-back" size={25} />
          </Pressable>
          <Text style={styles.topTitle}>
            {mode === "create" ? "New note" : `Revision ${revision ?? "—"}`}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: !canSave }}
            disabled={!canSave}
            onPress={() => void save()}
            style={[styles.save, !canSave && styles.disabled]}
          >
            <Text style={styles.saveText}>{busy ? "Saving…" : "Save"}</Text>
          </Pressable>
        </View>

        <ScrollView
          contentContainerStyle={styles.content}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
        >
          <TextInput
            accessibilityLabel="Note title"
            keyboardAppearance="dark"
            maxLength={200}
            onChangeText={(title) => change((current) => ({ ...current, title }))}
            placeholder="Title"
            placeholderTextColor={nativeTheme.color.textDisabled}
            selectionColor={nativeTheme.color.accent}
            style={styles.titleInput}
            value={value.title}
          />

          <ScrollView
            contentContainerStyle={styles.typeRow}
            horizontal
            showsHorizontalScrollIndicator={false}
          >
            {noteTypes.map((type) => (
              <Pressable
                key={type}
                accessibilityRole="radio"
                accessibilityState={{ disabled: mode === "edit", selected: value.type === type }}
                disabled={mode === "edit"}
                onPress={() => change((current) => ({ ...current, type }))}
                style={[
                  styles.type,
                  value.type === type && styles.typeActive,
                  mode === "edit" && value.type !== type && styles.disabled
                ]}
              >
                <Text style={[styles.typeText, value.type === type && styles.typeTextActive]}>
                  {noteTypeLabel(type)}
                </Text>
              </Pressable>
            ))}
          </ScrollView>

          {interactiveContent}

          <View accessibilityRole="toolbar" style={styles.toolbar}>
            <Pressable
              accessibilityLabel="Undo edit"
              accessibilityRole="button"
              accessibilityState={{ disabled: past.length === 0 }}
              disabled={past.length === 0}
              onPress={undo}
              style={[styles.tool, past.length === 0 && styles.disabled]}
            >
              <Ionicons color={nativeTheme.color.textPrimary} name="arrow-undo" size={19} />
            </Pressable>
            <Pressable
              accessibilityLabel="Redo edit"
              accessibilityRole="button"
              accessibilityState={{ disabled: future.length === 0 }}
              disabled={future.length === 0}
              onPress={redo}
              style={[styles.tool, future.length === 0 && styles.disabled]}
            >
              <Ionicons color={nativeTheme.color.textPrimary} name="arrow-redo" size={19} />
            </Pressable>
            <Pressable
              accessibilityLabel="Add heading"
              onPress={() => insert("## ")}
              style={styles.tool}
            >
              <Text style={styles.toolText}>H2</Text>
            </Pressable>
            <Pressable
              accessibilityLabel="Add checklist item"
              onPress={() => insert("- [ ] ")}
              style={styles.tool}
            >
              <Ionicons color={nativeTheme.color.textPrimary} name="checkbox-outline" size={20} />
            </Pressable>
            <Pressable
              accessibilityLabel="Add bullet"
              onPress={() => insert("- ")}
              style={styles.tool}
            >
              <Ionicons color={nativeTheme.color.textPrimary} name="list" size={20} />
            </Pressable>
            <Pressable
              accessibilityLabel="Add bold markers"
              onPress={() => insert("**", "**")}
              style={styles.tool}
            >
              <Text style={styles.toolText}>B</Text>
            </Pressable>
            <View style={styles.toolbarSpacer} />
            <Pressable
              accessibilityRole="button"
              onPress={() => setPreview((current) => !current)}
              style={styles.previewToggle}
            >
              <Text style={styles.previewToggleText}>{preview ? "Edit" : "Preview"}</Text>
            </Pressable>
          </View>

          {preview ? (
            <MarkdownPreview markdown={value.bodyMarkdown} />
          ) : (
            <TextInput
              ref={bodyRef}
              accessibilityLabel="Note body in Markdown"
              keyboardAppearance="dark"
              multiline
              onChangeText={(bodyMarkdown) => change((current) => ({ ...current, bodyMarkdown }))}
              placeholder="Write in Markdown…"
              placeholderTextColor={nativeTheme.color.textDisabled}
              selectionColor={nativeTheme.color.accent}
              style={styles.bodyInput}
              textAlignVertical="top"
              value={value.bodyMarkdown}
            />
          )}

          <NoteMetadataFields
            currentNoteId={currentNoteId}
            linkCandidates={linkCandidates}
            links={value.links}
            onChangeLinks={(links) => change((current) => ({ ...current, links }))}
            onChangeSpace={(spaceId) => change((current) => ({ ...current, spaceId }))}
            onChangeTags={(tagIds) => change((current) => ({ ...current, tagIds }))}
            onCreateTag={onCreateTag}
            spaceId={value.spaceId}
            spaces={spaces}
            tagIds={value.tagIds}
            tags={tags}
          />

          <Pressable
            accessibilityRole="switch"
            accessibilityState={{ checked: value.privacy === "private_manual" }}
            onPress={() =>
              change((current) => ({
                ...current,
                privacy: current.privacy === "private_manual" ? "ai_assisted" : "private_manual"
              }))
            }
            style={styles.privacyRow}
          >
            <View>
              <Text style={styles.privacyTitle}>Private note</Text>
              <Text style={styles.privacyBody}>Excluded from AI requests and embeddings.</Text>
            </View>
            <Ionicons
              color={
                value.privacy === "private_manual"
                  ? nativeTheme.color.accent
                  : nativeTheme.color.textSecondary
              }
              name={value.privacy === "private_manual" ? "toggle" : "toggle-outline"}
              size={34}
            />
          </Pressable>
          {secondaryActions}
          {externalConflict ? (
            <Text accessibilityLiveRegion="assertive" style={styles.error}>
              A newer revision is available. Your draft is still here; copy it or reload before
              saving.
            </Text>
          ) : null}
          <Text accessibilityLiveRegion="polite" style={styles.error}>
            {error}
          </Text>
          {(externalConflict || error?.toLowerCase().includes("revision")) &&
          onReload !== undefined ? (
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() => void reload()}
              style={styles.reload}
            >
              <Text style={styles.reloadText}>Reload latest revision</Text>
            </Pressable>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  bodyInput: {
    color: nativeTheme.color.textPrimary,
    fontFamily: nativeTheme.fontFamily.sans,
    fontSize: 17,
    lineHeight: 26,
    minHeight: 330,
    paddingHorizontal: 0,
    paddingTop: 22
  },
  content: { paddingBottom: 64, paddingHorizontal: 20 },
  disabled: { opacity: 0.38 },
  error: { color: nativeTheme.color.danger, fontSize: 13, lineHeight: 19, minHeight: 40 },
  iconButton: { alignItems: "center", height: 44, justifyContent: "center", width: 44 },
  previewToggle: { justifyContent: "center", minHeight: 44, paddingHorizontal: 8 },
  previewToggleText: { color: nativeTheme.color.accent, fontSize: 13, fontWeight: "700" },
  privacyBody: { color: nativeTheme.color.textSecondary, fontSize: 13, marginTop: 3 },
  privacyRow: {
    alignItems: "center",
    borderTopColor: nativeTheme.color.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 16,
    minHeight: 76
  },
  privacyTitle: { color: nativeTheme.color.textPrimary, fontSize: 15, fontWeight: "600" },
  reload: { justifyContent: "center", minHeight: 44 },
  reloadText: { color: nativeTheme.color.accent, fontSize: 13, fontWeight: "700" },
  safeArea: { backgroundColor: nativeTheme.color.canvas, flex: 1 },
  save: { alignItems: "flex-end", justifyContent: "center", minHeight: 44, minWidth: 64 },
  saveText: { color: nativeTheme.color.accent, fontSize: 15, fontWeight: "700" },
  titleInput: {
    color: nativeTheme.color.textPrimary,
    fontSize: 30,
    fontWeight: "600",
    letterSpacing: -0.7,
    minHeight: 62,
    paddingHorizontal: 0
  },
  tool: { alignItems: "center", justifyContent: "center", minHeight: 44, minWidth: 44 },
  toolbar: {
    alignItems: "center",
    borderBottomColor: nativeTheme.color.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderTopColor: nativeTheme.color.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    marginTop: 18
  },
  toolbarSpacer: { flex: 1 },
  toolText: { color: nativeTheme.color.textPrimary, fontSize: 15, fontWeight: "800" },
  topBar: {
    alignItems: "center",
    borderBottomColor: nativeTheme.color.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 8
  },
  topTitle: { color: nativeTheme.color.textSecondary, fontSize: 13, fontWeight: "600" },
  type: {
    borderColor: nativeTheme.color.border,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: "center",
    minHeight: 34,
    paddingHorizontal: 13
  },
  typeActive: {
    backgroundColor: nativeTheme.color.textPrimary,
    borderColor: nativeTheme.color.textPrimary
  },
  typeRow: { gap: 8 },
  typeText: { color: nativeTheme.color.textSecondary, fontSize: 12, fontWeight: "700" },
  typeTextActive: { color: nativeTheme.color.canvas }
});

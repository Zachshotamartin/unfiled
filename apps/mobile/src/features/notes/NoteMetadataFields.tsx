import type { NoteLinkValue } from "@unfiled/contracts";
import { useMemo, useState, type ReactElement } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { nativeTheme } from "../../theme/nativeTheme";
import type { MobileNoteSummary, MobileSpace, MobileTag } from "./mobileNotesApi";

interface NoteMetadataFieldsProps {
  currentNoteId?: string;
  linkCandidates: MobileNoteSummary[];
  links: NoteLinkValue[];
  onChangeLinks: (links: NoteLinkValue[]) => void;
  onChangeSpace: (spaceId: string | null) => void;
  onChangeTags: (tagIds: string[]) => void;
  onCreateTag?: (name: string) => Promise<MobileTag>;
  spaceId: string | null;
  spaces: MobileSpace[];
  tagIds: string[];
  tags: MobileTag[];
}

export function NoteMetadataFields({
  currentNoteId,
  linkCandidates,
  links,
  onChangeLinks,
  onChangeSpace,
  onChangeTags,
  onCreateTag,
  spaceId,
  spaces,
  tagIds,
  tags
}: NoteMetadataFieldsProps): ReactElement {
  const [newTag, setNewTag] = useState("");
  const [tagBusy, setTagBusy] = useState(false);
  const [message, setMessage] = useState("");
  const candidates = useMemo(
    () =>
      linkCandidates.filter(
        ({ id }) => id !== currentNoteId && !links.some(({ toNoteId }) => toNoteId === id)
      ),
    [currentNoteId, linkCandidates, links]
  );

  const createTag = async (): Promise<void> => {
    const name = newTag.trim().toLowerCase();
    if (name.length === 0 || onCreateTag === undefined || tagBusy) return;
    setTagBusy(true);
    setMessage("");
    try {
      const tag = await onCreateTag(name);
      onChangeTags([...new Set([...tagIds, tag.id])]);
      setNewTag("");
    } catch {
      setMessage("That tag could not be created.");
    } finally {
      setTagBusy(false);
    }
  };

  const toggleTag = (id: string): void => {
    onChangeTags(tagIds.includes(id) ? tagIds.filter((tagId) => tagId !== id) : [...tagIds, id]);
  };

  const addLink = (note: MobileNoteSummary): void => {
    onChangeLinks([...links, { linkType: "related", toNoteId: note.id }]);
  };

  return (
    <View style={styles.root}>
      <Text style={styles.heading}>File this note</Text>
      <ScrollView
        contentContainerStyle={styles.chips}
        horizontal
        showsHorizontalScrollIndicator={false}
      >
        <Chip active={spaceId === null} label="Unfiled" onPress={() => onChangeSpace(null)} />
        {spaces.map((space) => (
          <Chip
            key={space.id}
            active={spaceId === space.id}
            label={space.name}
            onPress={() => onChangeSpace(space.id)}
          />
        ))}
      </ScrollView>

      <Text style={styles.heading}>Tags</Text>
      <View style={styles.wrap}>
        {tags.map((tag) => (
          <Chip
            key={tag.id}
            active={tagIds.includes(tag.id)}
            label={`#${tag.name}`}
            onPress={() => toggleTag(tag.id)}
          />
        ))}
      </View>
      <View style={styles.addRow}>
        <TextInput
          accessibilityLabel="New tag"
          autoCapitalize="none"
          keyboardAppearance="dark"
          maxLength={40}
          onChangeText={setNewTag}
          onSubmitEditing={() => void createTag()}
          placeholder="New tag"
          placeholderTextColor={nativeTheme.color.textDisabled}
          returnKeyType="done"
          selectionColor={nativeTheme.color.accent}
          style={styles.input}
          value={newTag}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: newTag.trim().length === 0 || tagBusy }}
          disabled={newTag.trim().length === 0 || tagBusy}
          onPress={() => void createTag()}
          style={styles.addButton}
        >
          <Text style={styles.addText}>{tagBusy ? "Adding…" : "Add"}</Text>
        </Pressable>
      </View>

      <Text style={styles.heading}>Note links</Text>
      {links.map((link) => {
        const note = linkCandidates.find(({ id }) => id === link.toNoteId);
        return (
          <View key={`${link.toNoteId}:${link.linkType}`} style={styles.linkRow}>
            <View style={styles.linkBody}>
              <Text numberOfLines={1} style={styles.linkTitle}>
                {note?.title ?? "Unavailable note"}
              </Text>
              <Text style={styles.linkKind}>{link.linkType}</Text>
            </View>
            <Pressable
              accessibilityLabel={`Change link to ${link.linkType === "related" ? "reference" : "related"}`}
              accessibilityRole="button"
              onPress={() =>
                onChangeLinks(
                  links.map((candidate) =>
                    candidate === link
                      ? {
                          ...candidate,
                          linkType: candidate.linkType === "related" ? "reference" : "related"
                        }
                      : candidate
                  )
                )
              }
              style={styles.linkAction}
            >
              <Text style={styles.linkActionText}>Change</Text>
            </Pressable>
            <Pressable
              accessibilityLabel={`Remove link to ${note?.title ?? "note"}`}
              accessibilityRole="button"
              onPress={() =>
                onChangeLinks(
                  links.filter(
                    ({ toNoteId, linkType }) =>
                      toNoteId !== link.toNoteId || linkType !== link.linkType
                  )
                )
              }
              style={styles.linkAction}
            >
              <Text style={styles.removeText}>Remove</Text>
            </Pressable>
          </View>
        );
      })}
      {candidates.length === 0 ? (
        <Text style={styles.help}>Create another note to link it here.</Text>
      ) : (
        <ScrollView
          contentContainerStyle={styles.chips}
          horizontal
          showsHorizontalScrollIndicator={false}
        >
          {candidates.map((note) => (
            <Chip
              key={note.id}
              active={false}
              label={`+ ${note.title}`}
              onPress={() => addLink(note)}
            />
          ))}
        </ScrollView>
      )}
      <Text accessibilityLiveRegion="polite" style={styles.message}>
        {message}
      </Text>
    </View>
  );
}

function Chip({ active, label, onPress }: { active: boolean; label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={[styles.chip, active && styles.chipActive]}
    >
      <Text numberOfLines={1} style={[styles.chipText, active && styles.chipTextActive]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  addButton: { justifyContent: "center", minHeight: 44, paddingHorizontal: 10 },
  addRow: { alignItems: "center", flexDirection: "row", gap: 8, marginTop: 8 },
  addText: { color: nativeTheme.color.accent, fontSize: 13, fontWeight: "700" },
  chip: {
    borderColor: nativeTheme.color.border,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: "center",
    maxWidth: 190,
    minHeight: 36,
    paddingHorizontal: 12
  },
  chipActive: {
    backgroundColor: nativeTheme.color.textPrimary,
    borderColor: nativeTheme.color.textPrimary
  },
  chips: { gap: 8, paddingRight: 16 },
  chipText: { color: nativeTheme.color.textSecondary, fontSize: 12, fontWeight: "700" },
  chipTextActive: { color: nativeTheme.color.canvas },
  heading: {
    color: nativeTheme.color.textSecondary,
    fontFamily: nativeTheme.fontFamily.mono,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.8,
    marginBottom: 9,
    marginTop: 18,
    textTransform: "uppercase"
  },
  help: { color: nativeTheme.color.textSecondary, fontSize: 13, lineHeight: 19 },
  input: {
    borderBottomColor: nativeTheme.color.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    color: nativeTheme.color.textPrimary,
    flex: 1,
    fontSize: 14,
    minHeight: 44
  },
  linkAction: { justifyContent: "center", minHeight: 44, paddingHorizontal: 7 },
  linkActionText: { color: nativeTheme.color.accent, fontSize: 12, fontWeight: "700" },
  linkBody: { flex: 1 },
  linkKind: { color: nativeTheme.color.textSecondary, fontSize: 11, marginTop: 3 },
  linkRow: { alignItems: "center", flexDirection: "row", minHeight: 54 },
  linkTitle: { color: nativeTheme.color.textPrimary, fontSize: 14, fontWeight: "600" },
  message: { color: nativeTheme.color.danger, fontSize: 12, minHeight: 18, paddingTop: 6 },
  removeText: { color: nativeTheme.color.danger, fontSize: 12, fontWeight: "700" },
  root: { borderTopColor: nativeTheme.color.border, borderTopWidth: StyleSheet.hairlineWidth },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 }
});

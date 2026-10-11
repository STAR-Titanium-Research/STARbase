// Whether the recording Save dialog is on screen. SaveCutDialog sets it while mounted. The rig-test
// prompt and run modal read it so they never mount over (and steal focus from) a dialog the
// operator is in the middle of: the Save dialog opens when a cut ends, at the same moment the
// shell's status poll reports "not recording", which alone would let a waiting request pop up.
import { ref } from 'vue';

export const saveDialogOpen = ref(false);

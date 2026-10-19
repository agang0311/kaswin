// Browser storage binding only. Shared view/revision/cache rules live in scripts/store.
import {IndexedStore} from '../../scripts/core.mjs';
import {RoundStore} from '../../scripts/store/round-store.mjs';
export class RoundCatalog extends RoundStore {
  constructor(openStore = () => IndexedStore.open('kaswin-opus-rounds'), options) { super(openStore, options); }
}

use azalea::{
    inventory::{ItemSlot, Player},
    registry::Item,
};

const INVENTORY_SLOT_COUNT: usize = 36;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InventoryItemInfo {
    pub slot: usize,
    pub name: String,
    pub count: i32,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EquipmentInfo {
    pub head: Option<InventoryItemInfo>,
    pub chest: Option<InventoryItemInfo>,
    pub legs: Option<InventoryItemInfo>,
    pub feet: Option<InventoryItemInfo>,
    pub hand: Option<InventoryItemInfo>,
    pub offhand: Option<InventoryItemInfo>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct InventorySnapshot {
    pub items: Vec<InventoryItemInfo>,
    pub equipment: EquipmentInfo,
}

impl InventorySnapshot {
    pub fn from_player(player: &Player, selected_hotbar_slot: u8) -> Self {
        let items = player
            .inventory
            .iter()
            .enumerate()
            .filter_map(|(slot, item)| item_info(slot, item))
            .collect();
        let equipment = EquipmentInfo {
            head: item_info(5, &player.armor[0]),
            chest: item_info(6, &player.armor[1]),
            legs: item_info(7, &player.armor[2]),
            feet: item_info(8, &player.armor[3]),
            hand: player
                .inventory
                .get(27 + usize::from(selected_hotbar_slot))
                .and_then(|item| item_info(36 + usize::from(selected_hotbar_slot), item)),
            offhand: item_info(45, &player.offhand),
        };
        Self { items, equipment }
    }

    pub fn used_slots(&self) -> usize {
        self.items.len()
    }

    pub fn empty_slots(&self) -> usize {
        INVENTORY_SLOT_COUNT.saturating_sub(self.used_slots())
    }

    pub fn is_full(&self) -> bool {
        self.empty_slots() == 0
    }

    pub fn count_item(&self, name: &str) -> i64 {
        let name = normalize_item_name(name);
        self.items
            .iter()
            .filter(|item| normalize_item_name(&item.name) == name)
            .map(|item| i64::from(item.count))
            .sum()
    }

    pub fn inventory_report(&self, slot: Option<usize>) -> String {
        if let Some(slot) = slot {
            if slot >= INVENTORY_SLOT_COUNT {
                return "📦 Slot must be between 0 and 35.".to_owned();
            }
            return match self.items.iter().find(|item| item.slot == slot) {
                Some(item) => format!("📦 Slot {slot}: {}x {}", item.count, item.name),
                None => format!("📦 Slot {slot}: Empty"),
            };
        }

        if self.items.is_empty() {
            return "📦 Inventory is empty".to_owned();
        }

        let items = self
            .items
            .iter()
            .map(|item| format!("{}: {}x {}", item.slot, item.count, item.name))
            .collect::<Vec<_>>()
            .join("\n");
        format!(
            "📦 **Inventory** ({}/{} slots used):\n{items}",
            self.used_slots(),
            INVENTORY_SLOT_COUNT
        )
    }

    pub fn equipment_report(&self) -> String {
        let slots = [
            ("head", &self.equipment.head),
            ("chest", &self.equipment.chest),
            ("legs", &self.equipment.legs),
            ("feet", &self.equipment.feet),
            ("hand", &self.equipment.hand),
            ("offhand", &self.equipment.offhand),
        ];
        let contents = slots
            .iter()
            .map(|(name, item)| {
                format!(
                    "  {name}: {}",
                    item.as_ref()
                        .map(|item| item.name.as_str())
                        .unwrap_or("Empty")
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        format!("🛡️ **Equipment**\n{contents}")
    }
}

fn item_info(slot: usize, item: &ItemSlot) -> Option<InventoryItemInfo> {
    let item = item.as_present()?;
    if item.is_empty() {
        return None;
    }
    let registry_name = item.kind.to_string();
    Some(InventoryItemInfo {
        slot,
        name: registry_name
            .strip_prefix("minecraft:")
            .unwrap_or(&registry_name)
            .to_owned(),
        count: item.count,
    })
}

fn normalize_item_name(name: &str) -> String {
    let name = name.trim().to_ascii_lowercase();
    name.strip_prefix("minecraft:")
        .unwrap_or(&name)
        .replace(' ', "_")
}

#[cfg(test)]
mod tests {
    use super::*;
    use azalea::inventory::ItemSlotData;

    fn present_item(kind: Item, count: i32) -> ItemSlot {
        ItemSlot::Present(ItemSlotData {
            count,
            kind,
            components: Default::default(),
        })
    }

    #[test]
    fn snapshot_reports_inventory_counts_and_selected_equipment() {
        let mut player = Player::default();
        player.inventory[0] = present_item(Item::IronIngot, 12);
        player.inventory[28] = present_item(Item::DiamondSword, 1);
        player.armor[0] = present_item(Item::IronHelmet, 1);
        player.offhand = present_item(Item::Shield, 1);

        let snapshot = InventorySnapshot::from_player(&player, 1);

        assert_eq!(snapshot.used_slots(), 2);
        assert_eq!(snapshot.empty_slots(), 34);
        assert!(!snapshot.is_full());
        assert_eq!(snapshot.count_item("minecraft:iron_ingot"), 12);
        assert_eq!(snapshot.count_item("DIAMOND_SWORD"), 1);
        assert_eq!(
            snapshot.equipment.head.as_ref().unwrap().name,
            "iron_helmet"
        );
        assert_eq!(
            snapshot.equipment.hand.as_ref().unwrap().name,
            "diamond_sword"
        );
        assert_eq!(snapshot.equipment.offhand.as_ref().unwrap().name, "shield");
    }

    #[test]
    fn slot_reports_distinguish_empty_inventory_slots() {
        let snapshot = InventorySnapshot::default();
        assert_eq!(snapshot.inventory_report(Some(4)), "📦 Slot 4: Empty");
        assert_eq!(snapshot.inventory_report(None), "📦 Inventory is empty");
        assert_eq!(
            snapshot.inventory_report(Some(36)),
            "📦 Slot must be between 0 and 35."
        );
    }
}

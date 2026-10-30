/**
 * Bot Feature Modules
 * All feature plugins for the mc-ai-bot
 */

// Base feature class
export { BaseFeature } from './BaseFeature';

// Movement/Navigation module
export { MovementFeature, MovementFeatureConfig, MovementFeatureOptions } from './MovementFeature';

// Inventory management
export { InventoryFeature, InventoryFeatureConfig, InventoryFeatureOptions } from './InventoryFeature';

// Combat/PVP system
export { CombatFeature, CombatFeatureConfig, CombatFeatureOptions } from './CombatFeature';

// Building/Construction system
export { BuildingFeature, BuildingFeatureConfig, BuildingFeatureOptions } from './BuildingFeature';

// Mining/Resource gathering
export { MiningFeature, MiningFeatureConfig, MiningFeatureOptions } from './MiningFeature';

// Farming/Agriculture
export { FarmingFeature, FarmingFeatureConfig, FarmingFeatureOptions } from './FarmingFeature';

// Chat/AI integration (OpenAI)
export { ChatAIFeature, ChatAIFeatureConfig, ChatAIFeatureOptions } from './ChatAIFeature';

// Follow/Guard/Roam behaviors
export { FollowFeature, FollowFeatureConfig, FollowFeatureOptions } from './FollowFeature.js';
export { GuardFeature, GuardFeatureConfig, GuardFeatureOptions } from './GuardFeature.js';
export { RoamFeature, RoamFeatureConfig, RoamFeatureOptions } from './RoamFeature.js';

// Feature factory for easy registration
export { createAllFeatures, FeatureFactory } from './FeatureFactory.js';
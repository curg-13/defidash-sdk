# SDK Workspace

This workspace is the DefiDash SDK project.

## Default Persona

Work as the **@sdk-specialist** agent.

## Context

- Sui Move-based DeFi SDK (TypeScript)
- Uses PTB (Programmable Transaction Block) pattern
- Leverages @mysten/sui SDK
- Supported protocols: Suilend, Navi, Scallop

## Key Commands

```bash
npm run build          # Build SDK
npm run test           # Run tests
npm run lint           # Lint code
npm run example:*      # Run examples
```

## Applied Rules

- defi-security.md - Slippage protection, oracle safety, liquidation prevention
- sui-ptb-safety.md - Transaction construction, flash loan safety, gas estimation

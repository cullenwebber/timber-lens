<?php
/**
 * Demo Timber controller for the Timber Lens example workspace.
 */

$context = Timber::context();

$context['hero'] = [
    'heading' => get_field('hero_heading'),
    'text'    => get_field('hero_text'),
];

$context['cards'] = $cards;

Timber::render('views/page-home.twig', $context);

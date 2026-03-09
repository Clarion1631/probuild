import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TextInput, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { IconSymbol } from './ui/icon-symbol';

interface AddressAutocompleteProps {
    value: string;
    onSelect: (address: string, lat: number | null, lng: number | null) => void;
    placeholder?: string;
}

export default function AddressAutocomplete({ value, onSelect, placeholder = "Enter address..." }: AddressAutocompleteProps) {
    const [query, setQuery] = useState(value);
    const [results, setResults] = useState<any[]>([]);
    const [loading, setLoading] = useState(false);
    const [showResults, setShowResults] = useState(false);
    const debounceTimer = useRef<any>(null);

    useEffect(() => {
        setQuery(value);
    }, [value]);

    const fetchAddresses = async (text: string) => {
        if (text.length < 3) {
            setResults([]);
            return;
        }

        setLoading(true);
        try {
            // Photon API (OSM based) - Fast, free, no key needed
            const response = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(text)}&limit=5`);
            const data = await response.json();

            const suggestions = data.features.map((f: any) => {
                const p = f.properties;
                const name = p.name || '';
                const street = p.street || '';
                const houseNumber = p.housenumber || '';
                const city = p.city || p.town || '';
                const state = p.state || '';
                const postcode = p.postcode || '';
                const country = p.country || '';

                // Build readable address
                let fullAddress = '';
                if (houseNumber) fullAddress += `${houseNumber} `;
                if (street) fullAddress += `${street}, `;

                // If we have a name that's not the street or house number (e.g. "Smith Building")
                if (!street && name && name !== houseNumber) {
                    fullAddress += `${name}, `;
                }

                if (city) fullAddress += `${city}, `;
                if (state) fullAddress += `${state} `;
                if (postcode) fullAddress += `${postcode}`;

                return {
                    id: Math.random().toString(),
                    label: fullAddress.trim().replace(/,$/, ''),
                    lat: f.geometry.coordinates[1],
                    lng: f.geometry.coordinates[0],
                    raw: f
                };
            });

            setResults(suggestions);
            setShowResults(true);
        } catch (error) {
            console.error('Autocomplete error:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleTextChange = (text: string) => {
        setQuery(text);
        if (debounceTimer.current) clearTimeout(debounceTimer.current);

        if (text.length === 0) {
            setResults([]);
            setShowResults(false);
            onSelect('', null, null);
            return;
        }

        debounceTimer.current = setTimeout(() => {
            fetchAddresses(text);
        }, 500);
    };

    const handleSelect = (item: any) => {
        setQuery(item.label);
        setShowResults(false);
        onSelect(item.label, item.lat, item.lng);
    };

    return (
        <View style={styles.container}>
            <View style={styles.inputContainer}>
                <TextInput
                    style={styles.input}
                    value={query}
                    onChangeText={handleTextChange}
                    placeholder={placeholder}
                    placeholderTextColor="#9ca3af"
                />
                {loading && (
                    <ActivityIndicator size="small" color="#2563eb" style={styles.loader} />
                )}
            </View>

            {showResults && results.length > 0 && (
                <View style={styles.resultsContainer}>
                    {results.map((item) => (
                        <TouchableOpacity
                            key={item.id}
                            style={styles.resultItem}
                            onPress={() => handleSelect(item)}
                        >
                            <IconSymbol name="mappin.circle.fill" size={16} color="#6b7280" />
                            <Text style={styles.resultText} numberOfLines={1}>{item.label}</Text>
                        </TouchableOpacity>
                    ))}
                </View>
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        zIndex: 1000,
        width: '100%'
    },
    inputContainer: {
        position: 'relative',
        justifyContent: 'center'
    },
    input: {
        backgroundColor: '#f9fafb',
        borderWidth: 1,
        borderColor: '#d1d5db',
        borderRadius: 8,
        padding: 12,
        paddingRight: 40,
        fontSize: 16,
        color: '#1f2937'
    },
    loader: {
        position: 'absolute',
        right: 12
    },
    resultsContainer: {
        position: 'absolute',
        top: '100%',
        left: 0,
        right: 0,
        backgroundColor: 'white',
        borderRadius: 8,
        marginTop: 4,
        borderWidth: 1,
        borderColor: '#e5e7eb',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.1,
        shadowRadius: 8,
        elevation: 5,
        zIndex: 1001
    },
    resultItem: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: 12,
        borderBottomWidth: 1,
        borderBottomColor: '#f3f4f6',
        gap: 8
    },
    resultText: {
        fontSize: 14,
        color: '#374151',
        flex: 1
    }
});
